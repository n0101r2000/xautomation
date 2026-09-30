// Riko(企画・リサーチ)実巡回ロジック
// RSS/Reddit収集 → gpt-5(推論medium) でネタ選定・日本向けアレンジ → topic_candidates 投入
import { collectRss, collectReddit, type RawItem } from './sources'
import { callOpenAI } from './llm'

export const RIKO_SYSTEM = `あなたはRiko、日本向け「海外AI副業の検証部屋」メディアの企画・リサーチ担当です。
海外の副業・AIツール情報から、日本のX/noteフォロワー(副業に興味がある20-40代)に刺さるネタを選定します。

選定基準:
- 日本でまだ広まっていない海外の稼ぎ方・ツール・事例を優先
- 「具体的な金額」「再現手順が想像できる」「意外性がある」ものを高評価
- 単なるニュースより「日本で試したらどうなるか」の検証ネタになるものを優先
- 広告色が強いもの・信憑性が低いもの・古いネタは除外

出力形式(JSONのみ、説明文なし):
{
  "topics": [
    {
      "title_ja": "日本語のネタタイトル(30字以内、数字を含めると良い)",
      "why_hit": "なぜ日本で刺さるか(80字以内)",
      "appeal_axis": ["訴求軸を2-3個(例: 意外性, 再現性, 金額インパクト)"],
      "target_medium": "x_single | x_thread | note_free | note_paid のいずれか",
      "urgency": "high | medium | low",
      "source_index": 元記事の番号(0始まり)
    }
  ]
}

最大10件まで(目標10件)。良いネタが足りなければ少なくてよい。必ずJSONのみを出力すること。`

export interface RikoResult {
  ok: boolean
  collected: number
  inserted: number
  topics: any[]
  errors: string[]
  costUsd: number
  error?: string
}

export async function runRikoCrawl(db: D1Database, apiKey: string): Promise<RikoResult> {
  const errors: string[] = []
  // 1. 収集(RSS + Reddit 並列)
  const [rss, reddit] = await Promise.all([collectRss(10), collectReddit(6)])
  errors.push(...rss.errors, ...reddit.errors)
  const items: RawItem[] = [...reddit.items, ...rss.items].slice(0, 60)

  if (items.length === 0) {
    return { ok: false, collected: 0, inserted: 0, topics: [], errors, costUsd: 0, error: '収集0件(全ソース失敗)' }
  }

  // 2. 既存トピックのURL重複チェック用に直近のsource_urlsを取得
  const recentRows = await db
    .prepare(`SELECT source_urls FROM topic_candidates WHERE created_at >= datetime('now', '-7 days')`)
    .all()
  const knownUrls = new Set<string>()
  for (const row of recentRows.results || []) {
    try {
      for (const u of JSON.parse((row as any).source_urls || '[]')) knownUrls.add(u)
    } catch {}
  }
  const fresh = items.filter((it) => !knownUrls.has(it.url))
  if (fresh.length === 0) {
    return { ok: true, collected: items.length, inserted: 0, topics: [], errors, costUsd: 0, error: '新規記事なし(全て既出)' }
  }

  // 3. gpt-5(推論medium) でネタ選定 — 品質優先方針
  const listText = fresh
    .map((it, i) => `[${i}] (${it.source}${it.score ? ` / ${it.score}pt` : ''}) ${it.title}\n${it.summary ? it.summary.slice(0, 200) : ''}`)
    .join('\n\n')
  const llm = await callOpenAI(
    apiKey,
    'gpt-5',
    RIKO_SYSTEM,
    `本日収集した海外記事一覧です。日本向けネタとして有望なものを選定してください(目標10件):\n\n${listText}`,
    16000, // 推論(medium)トークンも上限に含まれるため余裕を持たせる
    'medium',
  )
  if (!llm.ok) {
    return { ok: false, collected: items.length, inserted: 0, topics: [], errors, costUsd: 0, error: `LLM選定失敗: ${llm.error}` }
  }

  // 4. JSONパース
  let parsed: any
  try {
    const jsonText = llm.content.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim()
    parsed = JSON.parse(jsonText)
  } catch {
    return { ok: false, collected: items.length, inserted: 0, topics: [], errors, costUsd: llm.costUsd || 0, error: `JSON解析失敗: ${llm.content.slice(0, 200)}` }
  }
  const topics = (parsed.topics || []).slice(0, 10)

  // 5. topic_candidates に投入
  let inserted = 0
  const insertedTopics: any[] = []
  for (const t of topics) {
    const src = fresh[t.source_index] || fresh[0]
    const topicId = `t-riko-${Date.now()}-${inserted}`
    try {
      await db
        .prepare(
          `INSERT INTO topic_candidates (topic_id, title_ja, appeal_axis, target_medium, source_urls, why_hit, urgency, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
        )
        .bind(
          topicId,
          String(t.title_ja || '').slice(0, 60),
          JSON.stringify(t.appeal_axis || []),
          ['x_single', 'x_thread', 'note_free', 'note_paid'].includes(t.target_medium) ? t.target_medium : 'x_single',
          JSON.stringify([src?.url].filter(Boolean)),
          String(t.why_hit || '').slice(0, 200),
          ['high', 'medium', 'low'].includes(t.urgency) ? t.urgency : 'medium',
        )
        .run()
      inserted++
      insertedTopics.push({ topic_id: topicId, ...t, source_url: src?.url, source_name: src?.source, source_summary: src?.summary || '' })
    } catch (e: any) {
      errors.push(`insert失敗: ${e.message}`)
    }
  }

  return { ok: true, collected: items.length, inserted, topics: insertedTopics, errors, costUsd: llm.costUsd || 0 }
}

// ============================================================
// Riko週次競合リサーチ(Phase D): 売れているAI副業系noteの傾向を収集し
// Alexの週次計画+月次まとめの価格・タイトル戦略の材料にする
// ソース: Yahoo!リアルタイム検索(無料)で「note 有料 AI」系の話題投稿を収集 → gpt-5で傾向分析
// ============================================================
export interface CompetitorResearchResult {
  ok: boolean
  reportId?: string
  bodyMd?: string
  collected: number
  costUsd: number
  error?: string
}

const COMPETITOR_KEYWORDS = ['AI副業 note 有料', 'note 売れた AI', 'ChatGPT note 販売', 'note 有料記事 収益']

export async function runRikoCompetitorResearch(db: D1Database, apiKey: string): Promise<CompetitorResearchResult> {
  const result: CompetitorResearchResult = { ok: false, collected: 0, costUsd: 0 }
  try {
    // 週次重複ガード
    const dup = await db
      .prepare(`SELECT report_id FROM analysis_reports WHERE report_type = 'competitor' AND created_at > datetime('now', '-6 days') LIMIT 1`)
      .first()
    if (dup) {
      result.ok = true
      result.error = '今週分は作成済みのためスキップ'
      return result
    }

    const { fetchYahooRealtime } = await import('./sources')
    const all: any[] = []
    for (const kw of COMPETITOR_KEYWORDS) {
      try {
        const tweets = await fetchYahooRealtime(kw)
        all.push(...tweets.map((t) => ({ ...t, keyword: kw })))
        await new Promise((r) => setTimeout(r, 800))
      } catch { /* キーワード単位の失敗は無視 */ }
    }
    // 重複除去 + エンゲージメント順
    const seen = new Set<string>()
    const uniq = all.filter((t) => { if (seen.has(t.tweetId)) return false; seen.add(t.tweetId); return true })
      .sort((a, b) => (b.rtCount * 2 + b.replyCount) - (a.rtCount * 2 + a.replyCount))
      .slice(0, 20)
    result.collected = uniq.length

    if (uniq.length === 0) {
      result.error = '競合情報の収集0件(今週はスキップ)'
      result.ok = true
      return result
    }

    const material = uniq.map((t, i) => `${i + 1}. [@${t.screenName} RT${t.rtCount}/返信${t.replyCount}] ${String(t.text).slice(0, 200)}`).join('\n')

    const llm = await callOpenAI(
      apiKey,
      'gpt-5',
      `あなたは「Riko」— 「Mさん / 海外AI副業の検証部屋」の企画・リサーチ担当です。X上で観測された「AI副業系noteの販売・購入に関する生の声」から、自アカウントのnote販売戦略に活かせる競合トレンドレポートを作成します。

## レポート構成(Markdown・800字以内)
1. **今売れているテーマ**: 観測された話題から売れ筋の切り口を2〜3個
2. **価格帯の相場感**: 言及されている価格があれば整理
3. **タイトルの傾向**: 反応が良いタイトルパターン
4. **来週うちが取るべき差別化**: 具体提案2つ(自アカウントは 単発¥100/月次まとめ¥500 の低価格・検証特化路線。メンバーシップは当面休止)

事実ベースで書き、観測データにないことは推測と明示すること。`,
      `## 観測データ(Yahoo!リアルタイム検索より・直近の話題投稿${uniq.length}件)\n${material}`,
      10000,
      'medium',
    )
    if (!llm.ok) {
      result.error = `競合分析失敗: ${llm.error}`
      return result
    }
    result.costUsd = llm.costUsd || 0

    const reportId = `ar-c-${Date.now()}`
    const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
    await db
      .prepare(`INSERT INTO analysis_reports (report_id, report_type, report_date, body_md, proposals_json, cost_usd) VALUES (?, 'competitor', ?, ?, NULL, ?)`)
      .bind(reportId, today, llm.content, result.costUsd)
      .run()

    result.ok = true
    result.reportId = reportId
    result.bodyMd = llm.content
    return result
  } catch (e: any) {
    result.error = e?.message || '競合リサーチエラー'
    return result
  }
}
