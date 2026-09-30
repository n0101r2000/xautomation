// Nana(秘書): 日次レポート生成 + 未処理タスクリマインド(指示書 L288-310 準拠)
// 毎日パイプライン末尾に実行。通知先は当面ダッシュボード表示。
import { callOpenAI, type LlmResult } from './llm'

export const NANA_SYSTEM = `あなたは「Nana」— AIバーチャルオフィス「Mさん / 海外AI副業の検証部屋」の秘書です。
取締役(Mさん)に毎日の業務レポートを届けます。

## レポートのルール
- 300字以内。簡潔に、数字を中心に
- 構成: ①今日のX投稿実績 ②note売上/記事状況 ③承認待ちの件数 ④明日の予定サマリ
- 承認待ちが24時間以上滞留している場合は冒頭に「⚠️ リマインド」として明記
- 敬体(です・ます)。絵文字は見出し記号程度に最小限
- 事実のみ。推測や提案はしない(提案はRuiの担当)

出力はレポート本文のみ(Markdown可)。前置き不要。`

export interface NanaResult {
  ok: boolean
  reportId?: string
  bodyMd?: string
  pendingCount: number
  stalePending: number
  costUsd: number
  error?: string
}

// ダッシュボード用の日次レポートを生成して daily_reports に保存
export async function runNanaReport(db: D1Database, apiKey: string): Promise<NanaResult> {
  const result: NanaResult = { ok: false, pendingCount: 0, stalePending: 0, costUsd: 0 }
  try {
    const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10) // JST日付

    // ① X投稿実績(本日公開分 + 承認待ち)
    const postStats: any = await db
      .prepare(
        `SELECT
           SUM(CASE WHEN published_at IS NOT NULL AND date(published_at) = date('now') THEN 1 ELSE 0 END) AS published_today,
           SUM(CASE WHEN approval_status = 'pending' THEN 1 ELSE 0 END) AS pending_posts,
           SUM(CASE WHEN approval_status = 'pending' AND created_at < datetime('now', '-24 hours') THEN 1 ELSE 0 END) AS stale_posts,
           SUM(CASE WHEN approval_status = 'approved' AND published_at IS NULL THEN 1 ELSE 0 END) AS approved_unpublished
         FROM x_posts`,
      )
      .first()

    // ② note記事状況
    const noteStats: any = await db
      .prepare(
        `SELECT
           SUM(CASE WHEN approval_status = 'pending' THEN 1 ELSE 0 END) AS pending_notes,
           SUM(CASE WHEN approval_status = 'pending' AND created_at < datetime('now', '-24 hours') THEN 1 ELSE 0 END) AS stale_notes,
           SUM(CASE WHEN published_at IS NOT NULL THEN sales_count ELSE 0 END) AS total_sales,
           SUM(CASE WHEN published_at IS NOT NULL THEN revenue_yen ELSE 0 END) AS total_revenue
         FROM note_articles`,
      )
      .first()

    // ③ 直近KPI(あれば)
    const kpi: any = await db
      .prepare(`SELECT date, x_followers, x_impressions_total, note_paid_sales FROM kpi_daily ORDER BY date DESC LIMIT 1`)
      .first()

    // ④ ゲート①(週次企画)の承認待ちネタ数
    const topicPending: any = await db
      .prepare(`SELECT COUNT(*) AS c FROM topic_candidates WHERE status = 'pending'`)
      .first()

    // ⑤' 返信承認待ち(ゲート②' リプライ自動返信) — テーブル未整備の環境でも落ちない
    let replyStats: any = null
    try {
      replyStats = await db
        .prepare(
          `SELECT COUNT(*) AS pending,
             SUM(CASE WHEN created_at < datetime('now', '-24 hours') THEN 1 ELSE 0 END) AS stale
           FROM x_replies WHERE approval_status = 'pending' AND draft_body != ''`,
        )
        .first()
    } catch { /* x_replies未整備 */ }

    // ⑤ 明日の予定(承認済み・投稿予定)
    const tomorrowPlan: any = await db
      .prepare(
        `SELECT COUNT(*) AS c FROM x_posts WHERE approval_status IN ('pending','approved') AND published_at IS NULL AND scheduled_at > datetime('now')`,
      )
      .first()

    const pendingPosts = Number(postStats?.pending_posts || 0)
    const pendingNotes = Number(noteStats?.pending_notes || 0)
    const stalePosts = Number(postStats?.stale_posts || 0)
    const staleNotes = Number(noteStats?.stale_notes || 0)
    const pendingReplies = Number(replyStats?.pending || 0)
    const staleReplies = Number(replyStats?.stale || 0)
    result.pendingCount = pendingPosts + pendingNotes + pendingReplies
    result.stalePending = stalePosts + staleNotes + staleReplies

    const facts = `## 本日(${today})の事実データ
- X投稿: 本日公開 ${postStats?.published_today || 0}件 / 承認待ち ${pendingPosts}件(うち24時間以上滞留 ${stalePosts}件) / 承認済み未投稿 ${postStats?.approved_unpublished || 0}件
- note: 承認待ち(ゲート③) ${pendingNotes}件(うち24時間以上滞留 ${staleNotes}件) / 累計売上 ${noteStats?.total_sales || 0}件・${noteStats?.total_revenue || 0}円
- リプライ返信: 承認待ち ${pendingReplies}件(うち24時間以上滞留 ${staleReplies}件)
- 最新KPI(${kpi?.date || 'データなし'}): フォロワー ${kpi?.x_followers ?? '—'} / インプレッション ${kpi?.x_impressions_total ?? '—'} / note販売 ${kpi?.note_paid_sales ?? '—'}
- ゲート①承認待ちネタ: ${topicPending?.c || 0}件
- 明日以降の投稿予定: ${tomorrowPlan?.c || 0}件

## 指示
上記の事実データから300字以内の日次レポートを作成してください。
${result.stalePending > 0 ? `承認待ちが24時間以上滞留しています(${result.stalePending}件)。冒頭に「⚠️ リマインド」を必ず入れてください。` : '滞留はありません。'}`

    const llm: LlmResult = await callOpenAI(apiKey, 'gpt-5-mini', NANA_SYSTEM, facts, 3000, 'low')
    if (!llm.ok) {
      result.error = `Nanaレポート生成失敗: ${llm.error}`
      return result
    }
    result.costUsd = llm.costUsd || 0

    const reportId = `nr-${Date.now()}`
    await db
      .prepare(
        `INSERT INTO daily_reports (report_id, report_date, body_md, pending_count, stale_pending, cost_usd) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(reportId, today, llm.content, result.pendingCount, result.stalePending, result.costUsd)
      .run()

    result.ok = true
    result.reportId = reportId
    result.bodyMd = llm.content
    return result
  } catch (e: any) {
    result.error = e?.message || 'Nana実行エラー'
    return result
  }
}
