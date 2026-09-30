// Rui(分析): 日次KPI分析 + 週次(日曜)7日総括+改善提案3つ(指示書 L312-330 準拠)
// 品質優先方針: 分析の質が改善サイクルの起点のため gpt-5 + 推論medium
import { callOpenAI, type LlmResult } from './llm'

export const RUI_SYSTEM = `あなたは「Rui」— AIバーチャルオフィス「Mさん / 海外AI副業の検証部屋」の分析担当です。
X投稿とnoteのKPIデータを分析し、仮説と改善アクションを導きます。

## 分析ルール
- 数字の変化には必ず仮説を付ける(「なぜそうなったか」)
- 前日比・前週比が5%未満の変化は「有意な変化なし」と扱い、無理に理由づけしない
- 提案は「実行可能な具体アクション」のみ。抽象論(「もっと頑張る」等)は禁止
- データが少ない・デモデータの場合は正直にその旨を明記し、データが揃った時に見るべき観点を示す
- 敬体。Markdownで簡潔に

## 日次分析の構成
1. 昨日のハイライト(数字+仮説)
2. 気になる点(あれば)
3. 今日注視すべき指標

## 週次分析の構成(日曜のみ)
1. 7日間の総括(主要数字の推移+仮説)
2. うまくいったこと / いかなかったこと
3. 改善提案3つ(それぞれ: タイトル / 理由 / 具体的な実行手順 / 期待効果)`

export interface RuiResult {
  ok: boolean
  reportType: 'daily' | 'weekly' | 'monthly'
  reportId?: string
  bodyMd?: string
  proposals?: { title: string; reason: string; action: string; expected: string }[]
  costUsd: number
  error?: string
}

// 直近データの収集(日次/週次共通)
async function collectKpiFacts(db: D1Database, days: number): Promise<string> {
  const kpiRows = await db
    .prepare(`SELECT * FROM kpi_daily ORDER BY date DESC LIMIT ?`)
    .bind(days + 1)
    .all()
  const kpis = (kpiRows.results || []) as any[]

  // 投稿別パフォーマンス(公開済み・直近)
  const postRows = await db
    .prepare(
      `SELECT slot_number, substr(body, 1, 60) AS body_head, impressions, engagements, date(published_at) AS pub_date
       FROM x_posts WHERE published_at IS NOT NULL AND published_at > datetime('now', ?)
       ORDER BY impressions DESC LIMIT 20`,
    )
    .bind(`-${days} days`)
    .all()
  const posts = (postRows.results || []) as any[]

  // 枠別平均
  const slotRows = await db
    .prepare(
      `SELECT slot_number, COUNT(*) AS n, AVG(impressions) AS avg_imp, AVG(engagements) AS avg_eng
       FROM x_posts WHERE published_at IS NOT NULL AND published_at > datetime('now', ?)
       GROUP BY slot_number ORDER BY avg_imp DESC`,
    )
    .bind(`-${days} days`)
    .all()
  const slots = (slotRows.results || []) as any[]

  // note状況
  const noteRows = await db
    .prepare(
      `SELECT title, type, price_yen, view_count, sales_count, revenue_yen, date(published_at) AS pub_date
       FROM note_articles WHERE published_at IS NOT NULL ORDER BY published_at DESC LIMIT 10`,
    )
    .all()
  const notes = (noteRows.results || []) as any[]

  // ③ アフィリンククリック集計(/go/:link_id 経由の計測)
  let clicks: any[] = []
  try {
    const clickRows = await db
      .prepare(
        `SELECT l.tool_name, l.program, COUNT(c.id) AS clicks
         FROM affiliate_clicks c JOIN affiliate_links l ON l.link_id = c.link_id
         WHERE c.clicked_at > datetime('now', ?)
         GROUP BY c.link_id ORDER BY clicks DESC`,
      )
      .bind(`-${days} days`)
      .all()
    clicks = (clickRows.results || []) as any[]
  } catch { /* affiliate_clicks未整備の環境でも分析は続行 */ }

  const kpiText = kpis.length
    ? kpis.map((k) => `${k.date}: フォロワー${k.x_followers} / imp${k.x_impressions_total} / eng${k.x_engagements_total} / note販売${k.note_paid_sales} / アフィ収益${k.affiliate_revenue}円`).join('\n')
    : '(KPIデータなし)'
  const postText = posts.length
    ? posts.map((p) => `[枠${p.slot_number}|${p.pub_date}] imp${p.impressions} eng${p.engagements}: ${p.body_head}…`).join('\n')
    : '(公開済み投稿の実績データなし — X API未接続のため計測値は未取得)'
  const slotText = slots.length
    ? slots.map((s) => `枠${s.slot_number}: ${s.n}本 / 平均imp${Math.round(s.avg_imp)} / 平均eng${(s.avg_eng || 0).toFixed(1)}`).join('\n')
    : '(枠別データなし)'
  const noteText = notes.length
    ? notes.map((n) => `[${n.type}|${n.pub_date}] ${n.title}: view${n.view_count} 売上${n.sales_count}件/${n.revenue_yen}円`).join('\n')
    : '(公開済みnoteなし)'
  const clickText = clicks.length
    ? clicks.map((cl) => `${cl.tool_name}${cl.program ? `(${cl.program})` : ''}: ${cl.clicks}クリック`).join('\n')
    : '(クリックなし — アフィリンク未埋込または読者がまだ踏んでいない)'

  return `## KPI日次推移(直近${days + 1}日)
${kpiText}

## 投稿別実績(直近${days}日・imp上位)
${postText}

## 枠別平均(直近${days}日)
${slotText}

## note実績
${noteText}

## アフィリンククリック(直近${days}日・/go/計測)
${clickText}

※注意: X API未接続の期間は投稿実績・KPIがデモ/ゼロ値の可能性があります。その場合は分析にその前提を明記してください。`
}

// 日次分析(毎日実行)
export async function runRuiDaily(db: D1Database, apiKey: string): Promise<RuiResult> {
  const result: RuiResult = { ok: false, reportType: 'daily', costUsd: 0 }
  try {
    const facts = await collectKpiFacts(db, 3)
    const llm: LlmResult = await callOpenAI(
      apiKey,
      'gpt-5',
      RUI_SYSTEM,
      `以下のデータをもとに【日次分析】を作成してください。\n\n${facts}`,
      12000, // 推論トークン込み
      'medium',
    )
    if (!llm.ok) {
      result.error = `Rui日次分析失敗: ${llm.error}`
      return result
    }
    result.costUsd = llm.costUsd || 0
    const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
    const reportId = `ar-d-${Date.now()}`
    await db
      .prepare(`INSERT INTO analysis_reports (report_id, report_type, report_date, body_md, cost_usd) VALUES (?, 'daily', ?, ?, ?)`)
      .bind(reportId, today, llm.content, result.costUsd)
      .run()
    result.ok = true
    result.reportId = reportId
    result.bodyMd = llm.content
    return result
  } catch (e: any) {
    result.error = e?.message || 'Rui日次実行エラー'
    return result
  }
}

// 週次分析(日曜実行): 7日総括 + 改善提案3つ → Alexの週次計画の入力になる
export async function runRuiWeekly(db: D1Database, apiKey: string): Promise<RuiResult> {
  const result: RuiResult = { ok: false, reportType: 'weekly', costUsd: 0 }
  try {
    const facts = await collectKpiFacts(db, 7)
    const userPrompt = `以下のデータをもとに【週次分析】を作成してください。

${facts}

## 出力形式(必ずこの2部構成)
まずMarkdownで週次分析本文(7日間総括/うまくいったこと・いかなかったこと)を書き、
最後に必ず以下のJSONブロックを出力してください:

\`\`\`json
{"proposals":[{"title":"提案タイトル","reason":"理由","action":"具体的な実行手順","expected":"期待効果"},{...},{...}]}
\`\`\`

提案は必ず3つ。実行可能な具体アクションのみ。`

    const llm: LlmResult = await callOpenAI(apiKey, 'gpt-5', RUI_SYSTEM, userPrompt, 14000, 'medium') // 推論トークン込み
    if (!llm.ok) {
      result.error = `Rui週次分析失敗: ${llm.error}`
      return result
    }
    result.costUsd = llm.costUsd || 0

    // JSONブロック抽出
    let proposals: RuiResult['proposals'] = []
    const jsonMatch = llm.content.match(/```json\s*([\s\S]*?)```/)
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1])
        if (Array.isArray(parsed.proposals)) proposals = parsed.proposals.slice(0, 3)
      } catch {
        /* 解析失敗時は本文のみ保存 */
      }
    }
    const bodyMd = llm.content.replace(/```json[\s\S]*?```/, '').trim()

    const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
    const reportId = `ar-w-${Date.now()}`
    await db
      .prepare(
        `INSERT INTO analysis_reports (report_id, report_type, report_date, body_md, proposals_json, cost_usd) VALUES (?, 'weekly', ?, ?, ?, ?)`,
      )
      .bind(reportId, today, bodyMd, JSON.stringify(proposals), result.costUsd)
      .run()
    result.ok = true
    result.reportId = reportId
    result.bodyMd = bodyMd
    result.proposals = proposals
    return result
  } catch (e: any) {
    result.error = e?.message || 'Rui週次実行エラー'
    return result
  }
}

// 月次分析: 毎月1日に前月30日分の総括+来月戦略 (取締役向け)
export async function runRuiMonthly(db: D1Database, apiKey: string): Promise<RuiResult> {
  const result: RuiResult = { ok: false, reportType: 'monthly', costUsd: 0 }
  try {
    // 同月の重複実行ガード
    const thisMonth = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 7)
    const existing = await db
      .prepare("SELECT report_id FROM analysis_reports WHERE report_type = 'monthly' AND report_date LIKE ? LIMIT 1")
      .bind(`${thisMonth}%`).first()
    if (existing) {
      result.ok = true
      result.error = '今月の月次分析は作成済みのためスキップしました'
      return result
    }

    const facts = await collectKpiFacts(db, 30)

    // 価格帯別の集計 (価格別CVRの材料): view→購入の転換率を価格ごとに算出
    let priceTierText = '(有料note実績なし)'
    try {
      const tierRows = await db
        .prepare(
          `SELECT price_yen, COUNT(*) AS articles, SUM(view_count) AS views, SUM(sales_count) AS sales, SUM(revenue_yen) AS revenue
           FROM note_articles WHERE published_at IS NOT NULL AND price_yen > 0
           GROUP BY price_yen ORDER BY price_yen ASC`,
        )
        .all()
      const tiers = (tierRows.results || []) as any[]
      if (tiers.length) {
        priceTierText = tiers
          .map((t) => {
            const cvr = t.views > 0 ? ((t.sales / t.views) * 100).toFixed(2) : '算出不可(view 0)'
            return `¥${t.price_yen}: 記事${t.articles}本 / view合計${t.views} / 販売${t.sales}件 / 収益${t.revenue}円 / CVR ${cvr}${t.views > 0 ? '%' : ''}`
          })
          .join('\n')
      }
    } catch { /* 集計失敗時はプロンプト内で言及なし */ }

    // 売上TOP記事 (共通点分析の材料)
    let topSalesText = '(売上データなし)'
    try {
      const topRows = await db
        .prepare(
          `SELECT title, type, price_yen, view_count, sales_count, revenue_yen, date(published_at) AS pub_date
           FROM note_articles WHERE published_at IS NOT NULL AND revenue_yen > 0
           ORDER BY revenue_yen DESC LIMIT 5`,
        )
        .all()
      const tops = (topRows.results || []) as any[]
      if (tops.length) {
        topSalesText = tops
          .map((n, i) => `${i + 1}位 [${n.type}|¥${n.price_yen}|${n.pub_date}] ${n.title}: view${n.view_count} / ${n.sales_count}件 / ${n.revenue_yen}円`)
          .join('\n')
      }
    } catch { /* 無視 */ }

    const userPrompt = `以下の30日分のデータをもとに【月次振り返り+来月戦略】を作成してください。取締役(Mさん)向けの報告書です。

${facts}

## 売上TOP記事(収益順)
${topSalesText}

## 価格帯別実績(CVR = 販売件数 ÷ view数)
${priceTierText}

## 出力形式(Markdown)
# 月次レポート
## 1. 今月の総括(数字ベース: フォロワー/インプ/note売上/収益)
## 2. うまくいったこと(仮説付き)
## 3. うまくいかなかったこと(仮説付き)
## 4. 売上TOP記事の共通点(タイトルの型・テーマ・価格・公開曜日・X導線の観点で分析。売上ゼロの場合はviewの多い記事の共通点を代わりに分析)
## 5. 価格別CVR(価格帯ごとの転換率を比較し、最適価格の仮説と価格戦略の提案を出す。データ不足時はその旨を明記し検証プランを提示)
## 6. 来月の戦略(優先度順に3〜5項目、それぞれ具体アクションと期待効果)

データが少ない/デモ値の場合はその旨を明記した上で、立ち上げ期として妥当な戦略を提示してください。`

    const llm: LlmResult = await callOpenAI(apiKey, 'gpt-5', RUI_SYSTEM, userPrompt, 16000, 'medium') // 推論トークン込み
    if (!llm.ok) {
      result.error = `Rui月次分析失敗: ${llm.error}`
      return result
    }
    result.costUsd = llm.costUsd || 0

    const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
    const reportId = `ar-m-${Date.now()}`
    await db
      .prepare(
        `INSERT INTO analysis_reports (report_id, report_type, report_date, body_md, proposals_json, cost_usd) VALUES (?, 'monthly', ?, ?, NULL, ?)`,
      )
      .bind(reportId, today, llm.content.trim(), result.costUsd)
      .run()
    result.ok = true
    result.reportId = reportId
    result.bodyMd = llm.content.trim()
    return result
  } catch (e: any) {
    result.error = e?.message || 'Rui月次実行エラー'
    return result
  }
}
