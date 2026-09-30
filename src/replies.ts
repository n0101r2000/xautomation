// P1-4 リプライ自動返信 (Sora + Yuto + Mio)
// 毎時cronから呼ばれる2つの処理:
//  1. collectMentionsAndDraft: メンション回収($0.001/件)→ 返信下書き生成(gpt-5-mini)→ QA → ゲート②へ
//  2. publishApprovedReplies: 承認済み返信を自動送信($0.015/件)
// X APIキー未設定時は何もしない (エラーにしない)

import { getXCredentials, fetchMyProfile, fetchMyMentions, postTweet, xWeightedLength, X_WEIGHT_LIMIT, isTransientXError, type XCredentials, type XMention } from './x-api'
import { callOpenAI } from './llm'
import { runQaCheck } from './qa-rules'

export interface ReplyCollectResult {
  ok: boolean
  fetched: number      // 取得したメンション数
  drafted: number      // 下書き生成数
  skippedNoCreds: boolean
  costUsd: number
  errors: string[]
}

export interface ReplyPublishResult {
  ok: boolean
  published: number
  skippedNoCreds: boolean
  details: string[]
  errors: string[]
}

const REPLY_SYSTEM = `あなたは「Sora」— 日本のX(旧Twitter)アカウント「Mさん / 海外AI副業の検証部屋」のSNS担当です。
アカウント本人(Mさん)として、届いたメンション(リプライ)に返信を書きます。

## アカウント設定
- 発信者: 会社員をしながら海外のAI副業情報を検証しているMさん(一人称は「僕」)
- トーン: 誠実・等身大・検証者目線。感謝を伝え、質問には知っている範囲で答える

## 返信ルール(必須)
1. 140字以内(日本語Xの1ツイート上限)。1〜3文で、相手の話に具体的に答える
2. 相手の名前(@〜)は書かない(返信機能で自動表示されるため)
3. 質問に答えられない場合は「検証してみます」「調べて発信しますね」と誠実に返す
4. 絵文字は1個まで。ハッシュタグ・URLは書かない
5. 宣伝(note誘導など)はしない。信頼構築を優先

## 法務ルール(絶対厳守)
- 「誰でも」「簡単に」「必ず」「確実に」稼げる系の断定表現は禁止(景表法)
- 収益は伝聞・検証過程として書く。投資利益の保証めいた表現は禁止

## スキップ判定
以下の場合は返信不要と判断し「SKIP」とだけ出力する:
- スパム・宣伝bot・意味不明な内容
- 攻撃的・炎上リスクのある内容(反応しないのが最善)
- 日本語でも英語でもない内容

出力は返信本文のみ(またはSKIP)。前置き・解説は不要。`

// メンション回収 → 返信下書き生成 → QA → x_replies保存
export async function collectMentionsAndDraft(
  db: D1Database,
  apiKey: string,
  env: Record<string, string | undefined>,
): Promise<ReplyCollectResult> {
  const result: ReplyCollectResult = { ok: true, fetched: 0, drafted: 0, skippedNoCreds: false, costUsd: 0, errors: [] }

  const creds = getXCredentials(env)
  if (!creds) {
    result.skippedNoCreds = true
    return result
  }

  // 自分のuserId (app_settingsにキャッシュしてUser Read $0.010を節約)
  let userId = ''
  let myUsername = ''
  try {
    const cached: any = await db.prepare("SELECT value FROM app_settings WHERE key = 'x_user_id'").first()
    if (cached?.value) {
      const parsed = JSON.parse(cached.value)
      userId = parsed.userId || ''
      myUsername = parsed.username || ''
    }
  } catch { /* なければ取得 */ }
  if (!userId) {
    const prof = await fetchMyProfile(creds)
    if (!prof.ok || !prof.userId) {
      result.ok = false
      result.errors.push(`プロフィール取得失敗: ${prof.error}`)
      return result
    }
    userId = prof.userId
    myUsername = prof.username || ''
    await db.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('x_user_id', ?, CURRENT_TIMESTAMP)")
      .bind(JSON.stringify({ userId, username: myUsername })).run()
  }

  // since_id (前回取得の最新ID) で差分取得
  let sinceId: string | undefined
  try {
    const s: any = await db.prepare("SELECT value FROM app_settings WHERE key = 'x_mentions_since_id'").first()
    if (s?.value) sinceId = s.value
  } catch { /* 初回 */ }

  const res = await fetchMyMentions(creds, userId, sinceId)
  if (!res.ok) {
    result.ok = false
    result.errors.push(`メンション取得失敗: ${res.error}`)
    return result
  }
  const mentions = res.mentions || []
  result.fetched = mentions.length

  // 注意: since_idは全件の下書き処理が終わった後に更新する。
  // 途中でLLM障害等が起きても、未処理メンションは次回再取得される(取りこぼし防止)。
  // 処理済み分は x_replies の UNIQUE(mention_tweet_id) + 事前チェックで重複しない。
  if (mentions.length === 0) {
    if (res.newestId) {
      await db.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('x_mentions_since_id', ?, CURRENT_TIMESTAMP)")
        .bind(res.newestId).run()
    }
    return result
  }
  let allProcessed = true

  for (const m of mentions) {
    try {
      // 自分自身の投稿(スレッド連投など)は除外
      if (m.authorId === userId) continue
      // 既に処理済みのメンションはスキップ (UNIQUE制約でも守られるが事前チェック)
      const dup = await db.prepare('SELECT reply_id FROM x_replies WHERE mention_tweet_id = ? LIMIT 1').bind(m.tweetId).first()
      if (dup) continue

      // 返信下書き生成 (gpt-5-mini: 短文なので軽量モデルで十分)
      const llm = await callOpenAI(apiKey, 'gpt-5-mini', REPLY_SYSTEM,
        `以下のメンションに返信してください。\n\n▓送信者: @${m.authorUsername}\n▓本文:\n${m.text.slice(0, 500)}`,
        2000, 'low')
      result.costUsd += llm.costUsd || 0
      if (!llm.ok || !llm.content) {
        result.errors.push(`下書き生成失敗(${m.tweetId}): ${llm.error}`)
        allProcessed = false // 未保存のまま残すので since_id を進めない → 次回再取得
        continue
      }
      let draft = llm.content.trim()
      if (draft === 'SKIP' || draft.startsWith('SKIP')) {
        // スパム等: rejected として記録し再処理を防ぐ
        await db.prepare(
          `INSERT OR IGNORE INTO x_replies (reply_id, mention_tweet_id, mention_author, mention_author_id, mention_text, draft_body, qa_status, approval_status, cost_usd)
           VALUES (?, ?, ?, ?, ?, '', 'ok', 'rejected', ?)`,
        ).bind(`r-${Date.now()}-${m.tweetId.slice(-6)}`, m.tweetId, `@${m.authorUsername}`, m.authorId, m.text.slice(0, 1000), llm.costUsd || 0).run()
        continue
      }

      // 文字数ガード: weighted 280(日本語約140字)超は送信時に必ず失敗するため、一度だけ短縮リトライ
      if (xWeightedLength(draft) > X_WEIGHT_LIMIT) {
        const shorten = await callOpenAI(apiKey, 'gpt-5-mini', REPLY_SYSTEM,
          `以下の返信案は長すぎます。意味を保ったまま120字以内に短縮してください。出力は短縮後の本文のみ。\n\n${draft}`,
          2000, 'low')
        result.costUsd += shorten.costUsd || 0
        if (shorten.ok && shorten.content && xWeightedLength(shorten.content.trim()) <= X_WEIGHT_LIMIT) {
          draft = shorten.content.trim()
        }
      }
      const overLimit = xWeightedLength(draft) > X_WEIGHT_LIMIT

      // Mio QA (静的ルール) — 文字数超過は needs_fix に格下げ(承認前に取締役が気づける)
      const qa = runQaCheck(draft, false)
      if (overLimit && qa.status === 'ok') {
        qa.status = 'needs_fix'
        qa.issues.push({ law: '文字数', matched: `${xWeightedLength(draft)}/280`, detail: 'Xの文字数上限(weighted 280)を超えています。短縮が必要です' } as any)
      }
      await db.prepare(
        `INSERT OR IGNORE INTO x_replies (reply_id, mention_tweet_id, mention_author, mention_author_id, mention_text, draft_body, qa_status, qa_issues, approval_status, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      ).bind(
        `r-${Date.now()}-${m.tweetId.slice(-6)}`,
        m.tweetId,
        `@${m.authorUsername}`,
        m.authorId,
        m.text.slice(0, 1000),
        draft,
        qa.status,
        JSON.stringify(qa.issues),
        llm.costUsd || 0,
      ).run()
      result.drafted++
    } catch (e: any) {
      allProcessed = false
      result.errors.push(`${m.tweetId}: ${e?.message || 'error'}`)
    }
  }

  // 全件処理できた場合のみ since_id を進める(失敗分は次回再取得、処理済み分は重複チェックで弾く)
  if (allProcessed && res.newestId) {
    await db.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('x_mentions_since_id', ?, CURRENT_TIMESTAMP)")
      .bind(res.newestId).run()
  }

  return result
}

// 承認済み返信の自動送信 (Post Create $0.015/件)
export async function publishApprovedReplies(
  db: D1Database,
  env: Record<string, string | undefined>,
): Promise<ReplyPublishResult> {
  const result: ReplyPublishResult = { ok: true, published: 0, skippedNoCreds: false, details: [], errors: [] }

  const creds = getXCredentials(env)
  if (!creds) {
    result.skippedNoCreds = true
    return result
  }

  const due = await db.prepare(
    `SELECT * FROM x_replies
     WHERE approval_status = 'approved' AND published_at IS NULL AND qa_status != 'ng'
     ORDER BY created_at ASC LIMIT 5`,
  ).all()

  for (const r of (due.results || []) as any[]) {
    try {
      // 送信前ガード: 文字数超過は送信しても必ず失敗するため、API課金せず即rejected化
      // (承認時にサーバ側でも検証するが、旧データ・別経路への防衛線として残す)
      const weight = xWeightedLength(String(r.draft_body || ''))
      if (weight > X_WEIGHT_LIMIT) {
        result.errors.push(`${r.mention_author}: 文字数超過(${weight}/280)のため送信中止`)
        await db.prepare("UPDATE x_replies SET approval_status = 'rejected' WHERE reply_id = ?").bind(r.reply_id).run()
        await db.prepare(
          "INSERT INTO worker_logs (worker_name, action, status, output_json, finished_at) VALUES ('sora', 'reply_publish', 'error', ?, CURRENT_TIMESTAMP)",
        ).bind(`${r.mention_author} への返信を却下: 文字数超過(${weight}/280)。編集して再承認してください`).run()
        continue
      }

      const post = await postTweet(creds, r.draft_body, undefined, undefined, r.mention_tweet_id)
      if (post.ok) {
        result.published++
        result.details.push(`${r.mention_author}: ${post.tweetUrl}`)
        await db.prepare("UPDATE x_replies SET published_at = datetime('now'), posted_tweet_id = ? WHERE reply_id = ?")
          .bind(post.tweetId, r.reply_id).run()
        await db.prepare(
          "INSERT INTO worker_logs (worker_name, action, status, output_json, finished_at) VALUES ('sora', 'reply_publish', 'success', ?, CURRENT_TIMESTAMP)",
        ).bind(`${r.mention_author} へ返信: ${post.tweetUrl}`).run()
      } else {
        result.errors.push(`${r.mention_author}: ${post.error}`)
        // 恒久エラー(リトライしても解決しない)は rejected にして無限リトライを防ぐ。
        // 一時的エラー(レート制限・5xx・ネットワーク)のみ次回リトライに残す。
        const err = post.error || ''
        const isTransient = isTransientXError(err)
        if (!isTransient) {
          await db.prepare("UPDATE x_replies SET approval_status = 'rejected' WHERE reply_id = ?").bind(r.reply_id).run()
        }
        await db.prepare(
          "INSERT INTO worker_logs (worker_name, action, status, output_json, finished_at) VALUES ('sora', 'reply_publish', 'error', ?, CURRENT_TIMESTAMP)",
        ).bind(`${r.mention_author} への返信失敗: ${err}${isTransient ? '(次回リトライ)' : '(却下済み — 内容を確認してください)'}`).run()
      }
      await new Promise((resolve) => setTimeout(resolve, 1500))
    } catch (e: any) {
      result.errors.push(`${r.reply_id}: ${e?.message || 'error'}`)
    }
  }

  if (result.errors.length > 0 && result.published === 0 && (due.results || []).length > 0) result.ok = false
  return result
}
