// P1-6 高実績投稿リサイクル (Yuto/Sora) — エバーグリーン運用
// 14日以上前に公開したインプレッション上位の投稿を、Yutoが新しい切り口でリライトして
// 翌日の空き枠(枠10: 実践報告)扱いで pending 投稿として再投入する。
// - 1日1本まで
// - 同じ元投稿は一度しかリサイクルしない (recycled_from で追跡)
// - QAを通し、通常の承認ゲート②を経由する (勝手に投稿しない)

import { callOpenAI, YUTO_SYSTEM } from './llm'
import { runQaCheck } from './qa-rules'

export interface RecycleResult {
  ok: boolean
  created: boolean
  sourcePostId?: string
  sourceImpressions?: number
  postId?: string
  costUsd: number
  error?: string
}

export async function runPostRecycle(
  db: D1Database,
  apiKey: string,
  resolveScheduledAt: (slot: number) => string, // 枠番号→翌日の投稿予定時刻 (パイプライン側の nextScheduledAt を注入)
): Promise<RecycleResult> {
  const result: RecycleResult = { ok: true, created: false, costUsd: 0 }
  try {
    // 今日すでにリサイクル済みならスキップ (1日1本)
    const todayDone = await db.prepare(
      `SELECT post_id FROM x_posts
       WHERE recycled_from IS NOT NULL AND date(created_at, '+9 hours') = date('now', '+9 hours') LIMIT 1`,
    ).first()
    if (todayDone) {
      result.error = 'スキップ: 本日分リサイクル済み'
      return result
    }

    // 14日以上前に公開・インプ上位・未リサイクルの投稿を1本選ぶ
    // 引用RT(quote_tweet_id)とnote告知(枠11)は除外 (文脈依存が強くリサイクルに不向き)
    const source: any = await db.prepare(
      `SELECT p.* FROM x_posts p
       WHERE p.published_at IS NOT NULL
         AND p.published_at < datetime('now', '-14 days')
         AND p.impressions > 0
         AND p.quote_tweet_id IS NULL
         AND p.slot_number != 11
         AND NOT EXISTS (SELECT 1 FROM x_posts r WHERE r.recycled_from = p.post_id)
       ORDER BY p.impressions DESC LIMIT 1`,
    ).first()
    if (!source) {
      result.error = 'スキップ: リサイクル対象なし(14日経過+実績ありの投稿がない)'
      return result
    }
    result.sourcePostId = source.post_id
    result.sourceImpressions = source.impressions

    // Yutoリライト: 同じテーマを新しい切り口で
    const llm = await callOpenAI(apiKey, 'gpt-5', YUTO_SYSTEM,
      `以下は${Math.round((Date.now() - new Date(source.published_at + 'Z').getTime()) / 86400000)}日前に投稿して反響が大きかった投稿です(インプレッション${source.impressions})。
同じテーマを「新しい切り口」でリライトして、再投稿用の本文を1本執筆してください。

## リライトルール
- コピペ再投稿はNG。構成・書き出し・具体例を変えて新鮮に見せる
- 元投稿で伝えた核心(なぜ反響があったか)は残す
- 「以前も書きましたが」等の言及は不要。独立した投稿として成立させる
- 200字程度

## 元投稿
${source.body}`,
      3000)
    result.costUsd = llm.costUsd || 0
    if (!llm.ok || !llm.content) {
      result.ok = false
      result.error = `リライト失敗: ${llm.error}`
      return result
    }
    const body = llm.content.trim()
    const qa = runQaCheck(body, /\bhttps?:\/\//.test(body))

    const postId = `p-recycle-${Date.now()}`
    await db.prepare(
      `INSERT INTO x_posts (post_id, topic_id, slot_number, scheduled_at, body, approval_status, qa_status, qa_issues, recycled_from)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    ).bind(
      postId,
      source.topic_id || null,
      source.slot_number, // 元と同じ枠タイプで再投稿
      resolveScheduledAt(source.slot_number),
      body,
      qa.status,
      JSON.stringify(qa.issues),
      source.post_id,
    ).run()
    result.created = true
    result.postId = postId
  } catch (e: any) {
    result.ok = false
    result.error = e?.message || 'リサイクルエラー'
  }
  return result
}
