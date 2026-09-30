// Alex(PM): 月曜に週次テーマ分解+曜日別タスク配分(指示書 L126-143 準拠)
// 入力: ゲート①承認済みネタ + Rui週次改善提案 + 直近KPI。出力: weekly_plans + task_queue
// 品質優先方針: 週の方向性を決める要のため gpt-5 + 推論high
import { callOpenAI, type LlmResult } from './llm'

export const ALEX_SYSTEM = `あなたは「Alex」— AIバーチャルオフィス「Mさん / 海外AI副業の検証部屋」のプロジェクトマネージャーです。
毎週月曜に、その週のテーマを決めてワーカーにタスクを配分します。

## 優先度の判断基準(この順)
1. 収益に直結するもの(有料note・アフィリエイト)
2. フォロワー増に効くもの(バズ狙いスレッド・図解)
3. 一般情報発信

## 計画のルール
- 週のテーマは1つに絞る(例:「海外で伸びているKDP出版の徹底検証週間」)
- 曜日別に「その日のX投稿の切り口」「note記事の方向」を配分する
- Rui(分析)の改善提案があれば必ず1つ以上を今週の計画に組み込み、どう反映したかを明記
- 実行可能な具体指示のみ。抽象論は禁止
- 敬体。Markdownで簡潔に

## 出力形式(必ずこの2部構成)
まずMarkdownで週次計画本文を書き、最後に必ず以下のJSONブロックを出力:

\`\`\`json
{
  "theme": "今週のテーマ(50字以内)",
  "tasks": [
    {"day": "月", "x_focus": "X投稿の切り口", "note_focus": "note記事の方向"},
    {"day": "火", "x_focus": "...", "note_focus": "..."},
    {"day": "水", "x_focus": "...", "note_focus": "..."},
    {"day": "木", "x_focus": "...", "note_focus": "..."},
    {"day": "金", "x_focus": "...", "note_focus": "..."},
    {"day": "土", "x_focus": "...", "note_focus": "..."},
    {"day": "日", "x_focus": "...", "note_focus": "有料note: ..."}
  ]
}
\`\`\``

export interface AlexResult {
  ok: boolean
  planId?: string
  theme?: string
  bodyMd?: string
  tasks?: { day: string; x_focus: string; note_focus: string }[]
  costUsd: number
  error?: string
}

// 今週の月曜(JST)を YYYY-MM-DD で返す
export function currentWeekStart(): string {
  const jst = new Date(Date.now() + 9 * 3600 * 1000)
  const day = jst.getUTCDay() // 0=日
  const diff = day === 0 ? 6 : day - 1
  jst.setUTCDate(jst.getUTCDate() - diff)
  return jst.toISOString().slice(0, 10)
}

// 今週の計画を取得(あれば)
export async function getCurrentWeekPlan(db: D1Database): Promise<any | null> {
  return await db.prepare(`SELECT * FROM weekly_plans WHERE week_start = ? ORDER BY created_at DESC LIMIT 1`).bind(currentWeekStart()).first()
}

// 週次計画の生成(月曜実行。既に今週分があればスキップ)
export async function runAlexWeeklyPlan(db: D1Database, apiKey: string): Promise<AlexResult> {
  const result: AlexResult = { ok: false, costUsd: 0 }
  try {
    const weekStart = currentWeekStart()
    const existing = await db.prepare(`SELECT plan_id FROM weekly_plans WHERE week_start = ?`).bind(weekStart).first()
    if (existing) {
      result.ok = true
      result.planId = (existing as any).plan_id
      result.error = '今週の計画は作成済みのためスキップしました'
      return result
    }

    // ① ゲート①承認済み+未使用ネタ
    const topicRows = await db
      .prepare(
        `SELECT title_ja, appeal_axis, target_medium, why_hit, urgency FROM topic_candidates
         WHERE status IN ('approved', 'pending') ORDER BY
           CASE status WHEN 'approved' THEN 0 ELSE 1 END,
           CASE urgency WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END
         LIMIT 15`,
      )
      .all()
    const topics = (topicRows.results || []) as any[]
    const topicText = topics.length
      ? topics.map((t) => `- [${t.urgency}|${t.target_medium}] ${t.title_ja}(${t.why_hit || t.appeal_axis || ''})`).join('\n')
      : '(ネタ在庫なし — 今週はRikoの新規収集ネタで運用)'

    // ② Rui最新の週次改善提案
    const ruiWeekly: any = await db
      .prepare(`SELECT body_md, proposals_json FROM analysis_reports WHERE report_type = 'weekly' ORDER BY report_date DESC LIMIT 1`)
      .first()
    let proposalText = '(Ruiの週次提案なし — 初週または分析データ不足)'
    if (ruiWeekly?.proposals_json) {
      try {
        const props = JSON.parse(ruiWeekly.proposals_json)
        if (Array.isArray(props) && props.length) {
          proposalText = props.map((p: any, i: number) => `${i + 1}. ${p.title}: ${p.action}(期待効果: ${p.expected})`).join('\n')
        }
      } catch { /* noop */ }
    }

    // ③.5 Rikoの競合リサーチ(あれば)
    const comp: any = await db
      .prepare(`SELECT body_md FROM analysis_reports WHERE report_type = 'competitor' ORDER BY report_date DESC LIMIT 1`)
      .first()
    const compText = comp?.body_md ? String(comp.body_md).slice(0, 1500) : '(競合リサーチなし)'

    // ③ 直近KPI
    const kpiRows = await db.prepare(`SELECT * FROM kpi_daily ORDER BY date DESC LIMIT 7`).all()
    const kpis = (kpiRows.results || []) as any[]
    const kpiText = kpis.length
      ? kpis.map((k) => `${k.date}: フォロワー${k.x_followers} / imp${k.x_impressions_total} / note販売${k.note_paid_sales}`).join('\n')
      : '(KPIデータなし)'

    const userPrompt = `今週(${weekStart}週)の週次計画を作成してください。

## ネタ在庫(ゲート①承認済み優先)
${topicText}

## Rui(分析)の週次改善提案
${proposalText}

## 直近7日のKPI
${kpiText}

## Rikoの競合リサーチ(AI副業系noteの売れ筋傾向)
${compText}

※商品ラインナップ: 日曜=有料単発note(100円)の執筆日。毎月1日=月次まとめnote(500円・主力商品)。メンバーシップは当面休止中(低価格noteのみで収益化)。
日曜の note_focus は有料記事の企画にしてください。
※最優先KPI: Xフォロワーの増加。x_focus は「フォローしたくなる切り口」(検証の続きが気になる・保存したくなる・共感できる)を意識してください。収益目標: まず0→1の初売上を作ること。`

    const llm: LlmResult = await callOpenAI(apiKey, 'gpt-5', ALEX_SYSTEM, userPrompt, 20000, 'high') // 推論(high)トークン込み
    if (!llm.ok) {
      result.error = `Alex週次計画失敗: ${llm.error}`
      return result
    }
    result.costUsd = llm.costUsd || 0

    // JSON抽出
    let theme = `${weekStart}週の計画`
    let tasks: AlexResult['tasks'] = []
    const jsonMatch = llm.content.match(/```json\s*([\s\S]*?)```/)
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1])
        if (parsed.theme) theme = String(parsed.theme).slice(0, 100)
        if (Array.isArray(parsed.tasks)) tasks = parsed.tasks
      } catch { /* noop */ }
    }
    const bodyMd = llm.content.replace(/```json[\s\S]*?```/, '').trim()

    const planId = `wp-${Date.now()}`
    await db
      .prepare(`INSERT INTO weekly_plans (plan_id, week_start, theme, body_md, tasks_json, cost_usd) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(planId, weekStart, theme, bodyMd, JSON.stringify(tasks), result.costUsd)
      .run()

    // task_queue にも曜日別タスクを登録(可視化用)
    for (const t of tasks || []) {
      await db
        .prepare(`INSERT INTO task_queue (worker_name, task_type, payload, status, priority) VALUES ('yuto', 'weekly_focus', ?, 'queued', 3)`)
        .bind(JSON.stringify({ week_start: weekStart, ...t }))
        .run()
    }

    result.ok = true
    result.planId = planId
    result.theme = theme
    result.bodyMd = bodyMd
    result.tasks = tasks
    return result
  } catch (e: any) {
    result.error = e?.message || 'Alex実行エラー'
    return result
  }
}
