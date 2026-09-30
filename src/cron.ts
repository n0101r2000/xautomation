// 全自動パイプライン(指示書準拠):
// [月曜] Alex週次計画 → Riko収集 → Kai翻訳 → Yuto執筆(+Aki枠3図解) → note執筆 → Rui分析(日曜は週次も) → Nana日次レポート
// 取締役の承認はゲート②(投稿一括)・ゲート③(有料note)のみ。途中承認なし。
import { runRikoCrawl, runRikoCompetitorResearch } from './riko'
import { translateSource } from './kai'
import { callOpenAI, YUTO_SYSTEM } from './llm'
import { runQaCheck } from './qa-rules'
import { runAlexWeeklyPlan, getCurrentWeekPlan } from './alex'
import { runNoteWriter, runMonthlySummaryNote } from './note-writer'
import { runAkiImagePlan, runAkiNoteCover, runAkiNoteDiagrams } from './aki'
import { runRuiDaily, runRuiWeekly, runRuiMonthly } from './rui'
import { runNanaReport } from './nana'
import { collectJaHotTweets, type JaHotTweet } from './sources'
import { runSoraScheduledPublish, type SoraPublishResult } from './sora'
import { collectKpiAuto } from './kpi-collector'
import { embedAffiliateLinks, resolveClickBase, type AffiliateLink } from './affiliate'
import { collectMentionsAndDraft, publishApprovedReplies, type ReplyCollectResult, type ReplyPublishResult } from './replies'
import { runSlotOptimize, loadSlotOverrides } from './slot-optimizer'
import { runPostRecycle } from './recycle'
import { getXCredentials, retweet, fetchMyProfile, fetchMyTweetsMetrics } from './x-api'

// 12枠タイムテーブル(X Premium加入・長文1投稿完結型・フォロワー獲得最優先)
// 短文と長文をメリハリよく配置: 長文読み物は通勤/昼/夜のゴールデンタイムに、短文は合間の接触頻度維持に
export const SLOT_TABLE: { slot: number; time: string; type: string; limit: string }[] = [
  { slot: 1, time: '06:30', type: '朝の海外ニュース解説', limit: '400〜800字' },
  { slot: 2, time: '07:30', type: '1日の予告', limit: '100字前後' },
  { slot: 3, time: '09:00', type: 'ノウハウ図解1枚', limit: '150字前後+画像' },
  { slot: 4, time: '11:00', type: '徹底解説長文(バズ狙い)', limit: '1500〜3000字' },
  { slot: 5, time: '12:15', type: '昼休みTips', limit: '150字前後' },
  { slot: 6, time: '14:00', type: '引用RT', limit: '100字前後' },
  { slot: 7, time: '16:00', type: 'ケーススタディ分解', limit: '600〜1200字' },
  { slot: 8, time: '18:00', type: 'ツール比較・アフィ', limit: '400〜800字' },
  { slot: 9, time: '19:30', type: '質問投げかけ', limit: '100字前後' },
  { slot: 10, time: '21:00', type: '実践報告・検証記録', limit: '800〜1500字' },
  { slot: 11, time: '22:30', type: 'note告知', limit: '150字前後' },
  { slot: 12, time: '23:30', type: '深夜の一言', limit: '100字前後' },
]

// 枠ごとの型ヒント(Yutoプロンプトに注入)— ツリー/スレッド分割は全廃、長文は1投稿に読みやすくまとめる
const SLOT_HINTS: Record<number, string> = {
  1: '海外のニュースを紹介して、それが日本の会社員にどう関係あるかまで噛み砕く。冒頭1行で「何の話か」がわかるように。要点は行間を空けて整理し、数字を1つ以上入れる。最後に出典URL',
  2: '今日発信する内容の予告。かしこまらず、朝の挨拶がてら軽く。100字前後',
  3: '図解画像を添付する前提の導入文。画像を見たくなる一言+図解の要点をひとこと',
  4: '【最重要枠・バズ狙い】1つのテーマを1投稿で徹底解説する長文(1500〜3000字)。冒頭2行で「読むと何がわかるか」を提示して足を止めさせる。見出し代わりの【】行と空行で区切り、スマホで流し読みできる構成に。途中に具体的な数字・手順・実例を入れ、最後は自分の正直な感想で締める。番号付きの「1/」「2/」のようなスレッド形式は絶対に使わない',
  5: '昼休みに30秒で読める軽いTips。難しい言葉を使わない',
  6: '話題ツイートを引用RTするコメント。100字前後',
  7: '海外の成功/失敗事例を1投稿で分解(600〜1200字)。「何がうまくいった(いかなかった)要因か」を僕の目線で。空行で段落を区切る',
  8: 'ツール比較を1投稿で(400〜800字)。それぞれの良し悪しを正直に。アフィリエイトリンク想定のため文末に #PR を明記',
  9: '読者への質問で終える。副業をやったことがない人でも答えられる身近な問い',
  10: '一人称の実践報告・検証記録(800〜1500字)。「実際にやってみたらこうだった」を時系列で。うまくいかなかった部分も正直に書く',
  11: 'note記事への誘導。売り込み感を出しすぎない',
  12: '1日の締めの一言。生活感や本音をこぼす',
}

function nextScheduledAt(time: string, offsetMinutes = 0): string {
  const [h, m] = time.split(':').map(Number)
  const now = new Date()
  const jstNow = new Date(now.getTime() + 9 * 3600 * 1000)
  const target = new Date(Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate() + 1, h - 9, m + offsetMinutes))
  return target.toISOString().replace('T', ' ').slice(0, 19)
}

async function logWorker(db: D1Database, worker: string, action: string, ok: boolean, output: any) {
  await db
    .prepare(`INSERT INTO worker_logs (worker_name, action, status, output_json, finished_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`)
    .bind(worker, action, ok ? 'success' : 'failed', JSON.stringify(output))
    .run()
}

// オフィス画面のワーカーアイコンと実処理を連動させる(失敗してもパイプラインは続行)
export async function setWorkerWorking(db: D1Database, worker: string, task: string) {
  try {
    await db.prepare("UPDATE worker_status SET status = 'working', current_task = ?, last_updated = CURRENT_TIMESTAMP WHERE worker_name = ?")
      .bind(task, worker).run()
  } catch { /* 表示用なので失敗は無視 */ }
}

export async function setWorkerIdle(db: D1Database, worker: string) {
  try {
    await db.prepare("UPDATE worker_status SET status = 'idle', current_task = '待機中', last_updated = CURRENT_TIMESTAMP WHERE worker_name = ?")
      .bind(worker).run()
  } catch { /* 表示用なので失敗は無視 */ }
}

async function resetAllWorkersIdle(db: D1Database) {
  try {
    await db.prepare("UPDATE worker_status SET status = 'idle', current_task = '待機中', last_updated = CURRENT_TIMESTAMP").run()
  } catch { /* 表示用なので失敗は無視 */ }
}

// 二重実行ガード: app_settingsの実行中フラグ(20分で自動失効 — 異常終了でフラグが残っても復旧可能)
const PIPELINE_LOCK_KEY = 'pipeline_running_at'
const PIPELINE_LOCK_STALE_MS = 20 * 60 * 1000

export async function acquirePipelineLock(db: D1Database): Promise<{ acquired: boolean; runningSinceMs?: number }> {
  try {
    const row: any = await db.prepare('SELECT value FROM app_settings WHERE key = ?').bind(PIPELINE_LOCK_KEY).first()
    if (row?.value) {
      const startedAt = Date.parse(row.value)
      if (!Number.isNaN(startedAt) && Date.now() - startedAt < PIPELINE_LOCK_STALE_MS) {
        return { acquired: false, runningSinceMs: Date.now() - startedAt }
      }
    }
    await db.prepare('INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)')
      .bind(PIPELINE_LOCK_KEY, new Date().toISOString()).run()
    return { acquired: true }
  } catch {
    // ロック取得自体の障害でパイプラインを止めない(ガードなしで続行)
    return { acquired: true }
  }
}

export async function releasePipelineLock(db: D1Database) {
  try {
    await db.prepare('DELETE FROM app_settings WHERE key = ?').bind(PIPELINE_LOCK_KEY).run()
  } catch { /* 次回は20分で自動失効するので継続可 */ }
}

export interface PipelineResult {
  ok: boolean
  kpi: { collected: boolean; xFollowers?: number; noteFollowers?: number; errors: string[] }
  alex: { ran: boolean; theme?: string; costUsd: number; error?: string }
  riko: { collected: number; inserted: number; costUsd: number; errors: string[] }
  competitor: { ran: boolean; collected: number; costUsd: number; error?: string }
  kai: { translated: number; costUsd: number; errors: string[] }
  yuto: { postsCreated: number; costUsd: number; errors: string[] }
  aki: { planned: number; generated: number; attached: number; qaFailed: number; costUsd: number; error?: string }
  noteDiagrams: { generated: number; costUsd: number; error?: string }
  note: { created: boolean; type?: string; title?: string; costUsd: number; error?: string }
  noteCover: { generated: boolean; costUsd: number; error?: string }
  monthlyNote: { created: boolean; title?: string; costUsd: number; error?: string }
  quote: { found: boolean; author?: string; score?: number; errors: string[] }
  rui: { daily: boolean; weekly: boolean; monthly: boolean; costUsd: number; errors: string[] }
  nana: { reported: boolean; costUsd: number; error?: string }
  mio: { checked: number; ok: number; needsFix: number; ng: number }
  slotOptimize: { ran: boolean; analyzed: number; changes: string[]; error?: string }
  recycle: { created: boolean; sourcePostId?: string; costUsd: number; error?: string }
  totalCostUsd: number
  error?: string
}

// JSTの曜日 (0=日曜, 1=月曜)
function jstDay(): number {
  return new Date(Date.now() + 9 * 3600 * 1000).getUTCDay()
}

// フルパイプライン実行(朝1回) — 二重実行ガード+ワーカー状態リセット付きラッパー
export async function runDailyPipeline(db: D1Database, r2: R2Bucket, apiKey: string, env?: Record<string, string | undefined>): Promise<PipelineResult> {
  const lock = await acquirePipelineLock(db)
  if (!lock.acquired) {
    const mins = Math.max(1, Math.round((lock.runningSinceMs || 0) / 60000))
    return {
      ok: false,
      error: `パイプラインは既に実行中です(約${mins}分前に開始。所要約5〜10分)。完了をお待ちください。`,
      kpi: { collected: false, errors: [] },
      alex: { ran: false, costUsd: 0 },
      riko: { collected: 0, inserted: 0, costUsd: 0, errors: [] },
      competitor: { ran: false, collected: 0, costUsd: 0 },
      kai: { translated: 0, costUsd: 0, errors: [] },
      yuto: { postsCreated: 0, costUsd: 0, errors: [] },
      aki: { planned: 0, generated: 0, attached: 0, qaFailed: 0, costUsd: 0 },
      noteDiagrams: { generated: 0, costUsd: 0 },
      note: { created: false, costUsd: 0 },
      noteCover: { generated: false, costUsd: 0 },
      monthlyNote: { created: false, costUsd: 0 },
      quote: { found: false, errors: [] },
      rui: { daily: false, weekly: false, monthly: false, costUsd: 0, errors: [] },
      nana: { reported: false, costUsd: 0 },
      mio: { checked: 0, ok: 0, needsFix: 0, ng: 0 },
      slotOptimize: { ran: false, analyzed: 0, changes: [] },
      recycle: { created: false, costUsd: 0 },
      totalCostUsd: 0,
    }
  }
  try {
    return await runDailyPipelineInner(db, r2, apiKey, env)
  } finally {
    await releasePipelineLock(db)
    await resetAllWorkersIdle(db) // 異常終了でもアイコンが「作業中」のまま固まらないように
  }
}

async function runDailyPipelineInner(db: D1Database, r2: R2Bucket, apiKey: string, env?: Record<string, string | undefined>): Promise<PipelineResult> {
  const result: PipelineResult = {
    ok: false,
    kpi: { collected: false, errors: [] },
    alex: { ran: false, costUsd: 0 },
    riko: { collected: 0, inserted: 0, costUsd: 0, errors: [] },
    competitor: { ran: false, collected: 0, costUsd: 0 },
    kai: { translated: 0, costUsd: 0, errors: [] },
    yuto: { postsCreated: 0, costUsd: 0, errors: [] },
    aki: { planned: 0, generated: 0, attached: 0, qaFailed: 0, costUsd: 0 },
    noteDiagrams: { generated: 0, costUsd: 0 },
    note: { created: false, costUsd: 0 },
    noteCover: { generated: false, costUsd: 0 },
    monthlyNote: { created: false, costUsd: 0 },
    quote: { found: false, errors: [] },
    rui: { daily: false, weekly: false, monthly: false, costUsd: 0, errors: [] },
    nana: { reported: false, costUsd: 0 },
    mio: { checked: 0, ok: 0, needsFix: 0, ng: 0 },
    slotOptimize: { ran: false, analyzed: 0, changes: [] },
    recycle: { created: false, costUsd: 0 },
    totalCostUsd: 0,
  }

  // ========== Phase -1: Nana KPI自動収集(Xフォロワー/noteフォロワー — 取れるものは全自動) ==========
  try {
    await setWorkerWorking(db, 'nana', 'KPIを自動収集中(X/note)')
    const kpi = await collectKpiAuto(db, env || {})
    result.kpi = { collected: kpi.ok, xFollowers: kpi.xFollowers, noteFollowers: kpi.noteFollowers, errors: kpi.errors.slice(0, 3) }
    await logWorker(db, 'nana', 'kpi_collect', kpi.ok, { xFollowers: kpi.xFollowers, noteFollowers: kpi.noteFollowers, noteLikes: kpi.noteLikesTotal, sources: kpi.sources, errors: kpi.errors.slice(0, 3) })
  } catch (e: any) {
    result.kpi.errors.push(e?.message || 'KPI収集エラー')
  } finally {
    await setWorkerIdle(db, 'nana')
  }

  // ========== Phase -0.5: Riko 競合リサーチ(月曜・Alex計画の前に実行して材料にする) ==========
  if (jstDay() === 1) {
    try {
      await setWorkerWorking(db, 'riko', '競合アカウントをリサーチ中')
      const comp = await runRikoCompetitorResearch(db, apiKey)
      result.competitor = { ran: comp.ok && !comp.error?.includes('スキップ'), collected: comp.collected, costUsd: comp.costUsd, error: comp.error }
      if (result.competitor.ran) await logWorker(db, 'riko', 'competitor_research', true, { collected: comp.collected, reportId: comp.reportId, costUsd: comp.costUsd })
    } catch (e: any) {
      result.competitor.error = e?.message
    }
  }

  // ========== Phase 0: Alex 週次計画(月曜、または今週分未作成なら作成) ==========
  try {
    const hasPlan = await getCurrentWeekPlan(db)
    if (jstDay() === 1 || !hasPlan) {
      await setWorkerWorking(db, 'alex', '週次計画を立案中')
      const alex = await runAlexWeeklyPlan(db, apiKey)
      result.alex = { ran: alex.ok && !alex.error?.includes('スキップ'), theme: alex.theme, costUsd: alex.costUsd, error: alex.error }
      if (alex.ok && !alex.error) await logWorker(db, 'alex', 'weekly_plan', true, { theme: alex.theme, costUsd: alex.costUsd })
      else if (!alex.ok) await logWorker(db, 'alex', 'weekly_plan', false, { error: alex.error })
    }
  } catch (e: any) {
    result.alex.error = e?.message
  } finally {
    await setWorkerIdle(db, 'alex')
  }

  // ========== Phase 1: Riko 巡回(10ネタ) ==========
  await setWorkerWorking(db, 'riko', '海外ソース巡回中(Reddit/RSS)')
  const riko = await runRikoCrawl(db, apiKey)
  await setWorkerIdle(db, 'riko')
  result.riko = { collected: riko.collected, inserted: riko.inserted, costUsd: riko.costUsd, errors: riko.errors.slice(0, 5) }
  await logWorker(db, 'riko', 'auto_crawl', riko.ok, { collected: riko.collected, inserted: riko.inserted, costUsd: riko.costUsd })
  if (!riko.ok || riko.topics.length === 0) {
    result.error = riko.error || 'Riko巡回で新規ネタが得られませんでした'
    // ネタゼロでも既存の翻訳済みネタで続行を試みる余地はあるが、シンプルに終了
    return result
  }

  // ========== Phase 2: Kai 翻訳(上位4ネタ: urgency優先) ==========
  await setWorkerWorking(db, 'kai', '一次情報を翻訳・要約中')
  const rank = { high: 0, medium: 1, low: 2 } as Record<string, number>
  const topTopics = [...riko.topics].sort((a, b) => (rank[a.urgency] ?? 1) - (rank[b.urgency] ?? 1)).slice(0, 4)
  const translations: { topic: any; markdown: string }[] = []
  for (const topic of topTopics) {
    const tr = await translateSource(apiKey, {
      title_ja: topic.title_ja,
      why_hit: topic.why_hit || '',
      source_url: topic.source_url || '',
      source_summary: topic.source_summary || '',
    })
    if (tr.ok) {
      translations.push({ topic, markdown: tr.content })
      result.kai.translated++
      result.kai.costUsd += tr.costUsd || 0
    } else {
      result.kai.errors.push(`${topic.title_ja}: ${tr.error}`)
    }
  }
  await logWorker(db, 'kai', 'auto_translate', result.kai.translated > 0, { translated: result.kai.translated, costUsd: result.kai.costUsd, errors: result.kai.errors.slice(0, 3) })
  await setWorkerIdle(db, 'kai')
  if (translations.length === 0) {
    result.error = 'Kai翻訳が全件失敗しました'
    return result
  }

  // ========== Phase 3: Yuto 執筆(12枠) + Phase 4: Mio QA ==========
  await setWorkerWorking(db, 'yuto', 'X投稿12枠を執筆中')
  await setWorkerWorking(db, 'mio', '執筆された投稿をQA審査中')
  const gl = await db.prepare('SELECT term, annotation FROM glossary LIMIT 30').all()
  const glossaryNote = ((gl.results || []) as any[]).map((g) => `※${g.term}=${g.annotation}`).join('\n')

  // 今週の計画(Alex)から今日の切り口を取得(あればYutoプロンプトに注入)
  let todayFocus = ''
  try {
    const plan: any = await getCurrentWeekPlan(db)
    if (plan?.tasks_json) {
      const dayNames = ['日', '月', '火', '水', '木', '金', '土']
      const todayName = dayNames[jstDay()]
      const tasks = JSON.parse(plan.tasks_json)
      const t = Array.isArray(tasks) ? tasks.find((x: any) => x.day === todayName) : null
      if (t) todayFocus = `\n▓今週のテーマ(Alexの週次計画): ${plan.theme}\n▓今日の切り口: ${t.x_focus || ''}`
    }
  } catch { /* 計画なしでも続行 */ }

  const createdPosts: { postId: string; slot: number; body: string; topicTitle: string }[] = []

  // P1-5: 週次(月曜)に枠別ベスト時間帯を再計算 → 以降のスケジュールに反映
  if (jstDay() === 1) {
    try {
      const opt = await runSlotOptimize(db, SLOT_TABLE.map((s) => ({ slot: s.slot, time: s.time })))
      result.slotOptimize = { ran: true, analyzed: opt.analyzed, changes: opt.changes, error: opt.error }
      await logWorker(db, 'rui', 'slot_optimize', opt.ok, { analyzed: opt.analyzed, overrides: opt.overrides, changes: opt.changes, error: opt.error })
    } catch (e: any) {
      result.slotOptimize.error = e?.message
    }
  }
  // 保存済みオーバーライドを読み込み (なければデフォルト時刻)
  let slotOverrides: Record<number, string> = {}
  try { slotOverrides = await loadSlotOverrides(db) } catch { /* デフォルト続行 */ }
  const slotTime = (slot: number, defTime: string) => slotOverrides[slot] || defTime

  // 枠8用: 登録済みアフィリンク(activeのみ)。0件なら埋め込みはスキップしてそのまま投稿(未登録でも正常動作)
  let affiliateLinks: AffiliateLink[] = []
  try {
    const al = await db.prepare("SELECT * FROM affiliate_links WHERE status = 'active' AND auto_embed = 1").all()
    affiliateLinks = (al.results || []) as any[]
  } catch { /* テーブルなしでも続行 */ }

  // 枠11用: 最新の公開済みnote(実URLあり)を取得 — 実際の記事への導線を作る
  let latestNote: any = null
  try {
    latestNote = await db
      .prepare(`SELECT title, type, price_yen, note_url FROM note_articles WHERE note_url IS NOT NULL AND note_url != '' ORDER BY published_at DESC LIMIT 1`)
      .first()
  } catch { /* なければ従来型 */ }

  // 発売日モード: 最新公開記事が有料(直近2日以内に公開)なら、枠2/枠11を販売導線強化
  let saleMode = false
  try {
    const recentPaid = await db
      .prepare(`SELECT article_id FROM note_articles WHERE type IN ('paid_single','monthly_summary') AND note_url IS NOT NULL AND published_at > datetime('now', '-2 days') LIMIT 1`)
      .first()
    saleMode = !!recentPaid
  } catch { /* 無視 */ }

  // 枠6用: 日本語の話題ツイートを収集(Yahoo!リアルタイム検索・無料)。見つからなければ従来型にフォールバック
  let quoteTarget: JaHotTweet | null = null
  try {
    const hot = await collectJaHotTweets(6)
    result.quote.errors = hot.errors
    // 過去に引用済みのツイートは除外
    for (const cand of hot.candidates) {
      const used = await db.prepare('SELECT post_id FROM x_posts WHERE quote_tweet_id = ? LIMIT 1').bind(cand.tweetId).first()
      if (!used) { quoteTarget = cand; break }
    }
    if (quoteTarget) {
      result.quote.found = true
      result.quote.author = `@${quoteTarget.screenName}`
      result.quote.score = quoteTarget.score
    }
    await logWorker(db, 'sora', 'quote_crawl', true, { candidates: hot.candidates.length, picked: quoteTarget ? `@${quoteTarget.screenName} (score=${quoteTarget.score})` : 'なし(通常投稿へ)', errors: hot.errors.slice(0, 2) })
  } catch (e: any) {
    result.quote.errors.push(e?.message || '話題ツイート収集エラー')
  }

  for (const slotDef of SLOT_TABLE) {
    const { topic, markdown } = translations[(slotDef.slot - 1) % translations.length]
    const isQuoteSlot = slotDef.slot === 6 && quoteTarget !== null
    const isNotePromoSlot = slotDef.slot === 11 && latestNote !== null
    const noteTypeJa = latestNote?.type === 'monthly_summary' ? `月次まとめ(¥${latestNote.price_yen})` : latestNote?.type === 'paid_single' ? `有料検証レポート(¥${latestNote.price_yen})` : latestNote?.type === 'membership' ? 'メンバーシップ限定' : '無料記事'
    const userPrompt = isNotePromoSlot
      ? `以下の公開済みnote記事へ読者を誘導するX投稿を1本執筆してください(枠11: note告知 / 22:30投稿 / 100字以内+URL)。

▓告知するnote記事:
- タイトル: ${latestNote.title}
- 種別: ${noteTypeJa}
- URL: ${latestNote.note_url}

▓執筆ルール:
- 本文の最後に必ずURLをそのまま含める(短縮・改変禁止)
- 記事で得られるものを1つだけ具体的に伝える(「書きました」だけはNG)
- 売り込み感を出しすぎない。僕の一言感想を添える${saleMode && latestNote.type !== 'free' ? '\n- 本日は有料記事の発売直後。価格(¥' + latestNote.price_yen + ')の手に取りやすさと、買うと何が分かるかを自然に伝える' : ''}${todayFocus}`
      : isQuoteSlot
      ? `以下の日本語の話題ツイートを引用リツイートするコメントを1本執筆してください(枠6: 引用RT / 14:00投稿 / 100字以内)。

▓引用元ツイート(@${quoteTarget!.screenName} / ${quoteTarget!.author}):
${quoteTarget!.text.slice(0, 500)}

▓執筆ルール:
- 原文に「僕の視点での気づき・補足・実体験」を1つ添える(単なる同意やおうむ返しはNG)
- 攻撃・皮肉・マウントは絶対NG。元投稿者への敬意を保つ
- 引用元が消えても単体で意味が通る文にする
- 100字以内。ハッシュタグは不要${todayFocus}`
      : `以下のKai(翻訳担当)の翻訳要約をもとに、「枠${slotDef.slot}: ${slotDef.type}(${slotDef.time}投稿 / ${slotDef.limit})」のX投稿を1本執筆してください。

▓枠の型: ${SLOT_HINTS[slotDef.slot]}

▓ネタ: ${topic.title_ja}
▓Kaiの翻訳要約:
${markdown.slice(0, 2500)}

▓参考: 既存の用語注釈集(同じ固有名詞はこの注釈を使う)
${glossaryNote}${todayFocus}${saleMode && slotDef.slot === 2 ? '\n\n▓追加指示: 本日は有料noteの発売直後です。1日の予告の中で「夜にnoteの話をします」的な自然な前振りを1文入れる' : ''}`

    // 長文枠(4/7/10)は最大3000字の本文+推論分でトークン予算を拡大
    const isLongSlot = [4, 7, 10].includes(slotDef.slot)
    const written = await callOpenAI(apiKey, 'gpt-5', YUTO_SYSTEM, userPrompt, isLongSlot ? 10000 : 3000, isLongSlot ? 'medium' : 'low')
    if (!written.ok) {
      result.yuto.errors.push(`枠${slotDef.slot}: ${written.error}`)
      continue
    }
    result.yuto.costUsd += written.costUsd || 0

    // Mio QA(キーワードエンジン)。要修正ならYutoが1回だけ自動リライト
    let body = written.content
    let qa = runQaCheck(body, slotDef.slot === 8 || /\bhttps?:\/\//.test(body))
    if (qa.status !== 'ok') {
      const rewrite = await callOpenAI(
        apiKey,
        'gpt-5',
        YUTO_SYSTEM,
        `以下の投稿がQAで指摘を受けました。指摘を解消しつつ同じ内容・枠の型を維持して書き直してください。書き直した本文のみを出力:\n\n▓指摘:\n${qa.issues.map((i) => `- ${i.law}: ${i.matched}(${i.detail})`).join('\n')}\n\n▓元の投稿:\n${body}`,
        isLongSlot ? 10000 : 3000,
      )
      if (rewrite.ok) {
        result.yuto.costUsd += rewrite.costUsd || 0
        const qa2 = runQaCheck(rewrite.content, slotDef.slot === 8 || /\bhttps?:\/\//.test(rewrite.content))
        if (qa2.status === 'ok' || (qa2.status === 'needs_fix' && qa.status === 'ng')) {
          body = rewrite.content
          qa = qa2
        }
      }
    }
    result.mio.checked++
    if (qa.status === 'ok') result.mio.ok++
    else if (qa.status === 'needs_fix') result.mio.needsFix++
    else result.mio.ng++

    // 枠8(ツール比較・アフィ枠): 登録済みアフィリンクをQA後の本文に自動埋め込み
    // リンク0件・ツール名不一致なら何も変えずそのまま(未登録でも正常動作)
    if (slotDef.slot === 8 && affiliateLinks.length > 0) {
      try {
        const clickBase = await resolveClickBase(db) // ③クリック計測: /go/:link_id 経由URLを埋め込む
        const emb = embedAffiliateLinks(body, affiliateLinks, clickBase)
        if (emb.changed) {
          body = emb.embedded
          await logWorker(db, 'sora', 'affiliate_embed', true, { slot: 8, tools: emb.detected.map((d) => d.tool_name), pr_added: emb.pr_added })
        }
      } catch { /* 埋め込み失敗でも投稿は継続 */ }
    }

    const postId = `p-auto-${Date.now()}-${slotDef.slot}`
    try {
      await db
        .prepare(
          `INSERT INTO x_posts (post_id, topic_id, slot_number, scheduled_at, body, approval_status, qa_status, qa_issues, quote_tweet_id, quote_author, quote_text)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
        )
        .bind(
          postId,
          isQuoteSlot ? null : topic.topic_id,
          slotDef.slot,
          nextScheduledAt(slotTime(slotDef.slot, slotDef.time)),
          body,
          qa.status,
          JSON.stringify(qa.issues),
          isQuoteSlot ? quoteTarget!.tweetId : null,
          isQuoteSlot ? `@${quoteTarget!.screenName}` : null,
          isQuoteSlot ? quoteTarget!.text.slice(0, 500) : null,
        )
        .run()
      result.yuto.postsCreated++
      createdPosts.push({ postId, slot: slotDef.slot, body, topicTitle: isQuoteSlot ? '引用RT' : topic.title_ja })
    } catch (e: any) {
      result.yuto.errors.push(`枠${slotDef.slot}保存失敗: ${e.message}`)
    }
  }

  // 使用したネタは published に(未使用の残りは pending のまま週次企画=ゲート①の材料に)
  for (const { topic } of translations) {
    await db.prepare(`UPDATE topic_candidates SET status = 'published' WHERE topic_id = ?`).bind(topic.topic_id).run()
  }

  await logWorker(db, 'yuto', 'auto_write', result.yuto.postsCreated > 0, { postsCreated: result.yuto.postsCreated, costUsd: result.yuto.costUsd, errors: result.yuto.errors.slice(0, 3) })
  await logWorker(db, 'mio', 'auto_qa', true, result.mio)
  await setWorkerIdle(db, 'yuto')
  await setWorkerIdle(db, 'mio')

  // ========== Phase 5: Aki 画像計画(全12枠を判定→必要な枠に生成・最大8枚) → Mio画像QA → 合格分のみ添付 ==========
  if (createdPosts.length > 0) {
    try {
      await setWorkerWorking(db, 'aki', '図解画像を生成中(最大8枚)')
      const aki = await runAkiImagePlan(db, r2, apiKey, createdPosts, 8)
      result.aki = { planned: aki.planned, generated: aki.generated, attached: aki.attached, qaFailed: aki.qaFailed, costUsd: aki.costUsd, error: aki.error }
      await logWorker(db, 'aki', 'image_plan', aki.ok, { planned: aki.planned, generated: aki.generated, attached: aki.attached, qaFailed: aki.qaFailed, details: aki.details.slice(0, 10), costUsd: aki.costUsd, error: aki.error })
    } catch (e: any) {
      result.aki.error = e?.message
    } finally {
      await setWorkerIdle(db, 'aki')
    }
  }

  // ========== Phase 5.5: 高実績投稿リサイクル(P1-6: 14日経過インプ上位を新しい切り口でリライト→ゲート②) ==========
  try {
    const defTimes: Record<number, string> = {}
    for (const s of SLOT_TABLE) defTimes[s.slot] = s.time
    // 通常枠と同時刻を避けるため+30分ずらして予約
    const rec = await runPostRecycle(db, apiKey, (slot) => nextScheduledAt(slotTime(slot, defTimes[slot] || '20:00'), 30))
    result.recycle = { created: rec.created, sourcePostId: rec.sourcePostId, costUsd: rec.costUsd, error: rec.error }
    if (rec.created || (rec.error && !rec.error.startsWith('スキップ'))) {
      await logWorker(db, 'yuto', 'post_recycle', rec.ok && rec.created, { sourcePostId: rec.sourcePostId, sourceImpressions: rec.sourceImpressions, postId: rec.postId, costUsd: rec.costUsd, error: rec.error })
    }
  } catch (e: any) {
    result.recycle.error = e?.message
  }

  // ========== Phase 6: Yuto note記事執筆(毎日1本: 日曜=有料¥100・土曜=メンバー限定・他=無料 → ゲート③) ==========
  let createdArticleId: string | null = null
  let createdArticleTitle = ''
  let createdArticleType = ''
  await setWorkerWorking(db, 'yuto', 'note記事を執筆中')
  try {
    // note向きのネタ(翻訳済みの中で本日未使用のものを優先、なければ先頭)
    const noteTopic = translations[translations.length - 1] || translations[0]
    const note = await runNoteWriter(db, apiKey, noteTopic.topic, noteTopic.markdown)
    result.note = { created: note.ok, type: note.type, title: note.title, costUsd: note.costUsd, error: note.error }
    if (note.ok && note.articleId) {
      createdArticleId = note.articleId
      createdArticleTitle = note.title || ''
      createdArticleType = note.type
    }
    await logWorker(db, 'yuto', 'auto_note', note.ok, { articleId: note.articleId, type: note.type, title: note.title, qaStatus: note.qaStatus, costUsd: note.costUsd, error: note.error })
  } catch (e: any) {
    result.note.error = e?.message
  }

  // ========== Phase 6.3: Yuto 月次まとめnote(¥500・主力商品・毎月1日) ==========
  const jstDateNum = new Date(Date.now() + 9 * 3600 * 1000).getUTCDate()
  if (jstDateNum === 1) {
    try {
      const ms = await runMonthlySummaryNote(db, apiKey)
      result.monthlyNote = { created: ms.ok && !ms.error?.includes('スキップ'), title: ms.title, costUsd: ms.costUsd, error: ms.error }
      if (result.monthlyNote.created) {
        await logWorker(db, 'yuto', 'monthly_note', true, { articleId: ms.articleId, title: ms.title, qaStatus: ms.qaStatus, costUsd: ms.costUsd })
        // カバー画像は月次まとめを優先
        if (ms.articleId) {
          createdArticleId = ms.articleId
          createdArticleTitle = ms.title || ''
          createdArticleType = 'monthly_summary'
        }
      }
    } catch (e: any) {
      result.monthlyNote.error = e?.message
    }
  }

  // ========== Phase 6.6: Aki noteカバー画像生成(購入率・読了率向上) ==========
  if (createdArticleId) {
    try {
      await setWorkerWorking(db, 'aki', 'noteカバー画像を生成中')
      const cover = await runAkiNoteCover(db, r2, apiKey, createdArticleId, createdArticleTitle, createdArticleType)
      result.noteCover = { generated: cover.ok, costUsd: cover.costUsd, error: cover.error }
      await logWorker(db, 'aki', 'note_cover', cover.ok, { imageId: cover.imageId, articleId: createdArticleId, qaStatus: cover.qaStatus, costUsd: cover.costUsd, error: cover.error })
    } catch (e: any) {
      result.noteCover.error = e?.message
    }
  }

  // ========== Phase 6.8: Aki 有料note本文用の図解(最大2枚) → Mio QA → ゲート③でDL ==========
  if (createdArticleId && ['paid_single', 'membership', 'monthly_summary'].includes(createdArticleType)) {
    try {
      const art: any = await db.prepare('SELECT body_md FROM note_articles WHERE article_id = ?').bind(createdArticleId).first()
      if (art?.body_md) {
        const diag = await runAkiNoteDiagrams(db, r2, apiKey, createdArticleId, createdArticleTitle, art.body_md)
        result.noteDiagrams = { generated: diag.generated, costUsd: diag.costUsd, error: diag.error }
        await logWorker(db, 'aki', 'note_diagrams', diag.ok, { articleId: createdArticleId, generated: diag.generated, imageIds: diag.imageIds, costUsd: diag.costUsd, error: diag.error })
      }
    } catch (e: any) {
      result.noteDiagrams.error = e?.message
    }
  }

  // ========== Phase 7: Rui 分析(毎日日次、日曜は週次も) ==========
  await setWorkerIdle(db, 'yuto')
  await setWorkerIdle(db, 'aki')
  try {
    await setWorkerWorking(db, 'rui', '本日の投稿実績を分析中')
    const ruiD = await runRuiDaily(db, apiKey)
    result.rui.daily = ruiD.ok
    result.rui.costUsd += ruiD.costUsd
    if (!ruiD.ok && ruiD.error) result.rui.errors.push(ruiD.error)
    await logWorker(db, 'rui', 'daily_analysis', ruiD.ok, { reportId: ruiD.reportId, costUsd: ruiD.costUsd, error: ruiD.error })

    if (jstDay() === 0) {
      const ruiW = await runRuiWeekly(db, apiKey)
      result.rui.weekly = ruiW.ok
      result.rui.costUsd += ruiW.costUsd
      if (!ruiW.ok && ruiW.error) result.rui.errors.push(ruiW.error)
      await logWorker(db, 'rui', 'weekly_analysis', ruiW.ok, { reportId: ruiW.reportId, proposals: ruiW.proposals?.length || 0, costUsd: ruiW.costUsd, error: ruiW.error })
    }

    // 毎月1日(JST): 月次振り返り+来月戦略(重複実行は関数側でガード)
    const jstDate = new Date(Date.now() + 9 * 3600 * 1000).getUTCDate()
    if (jstDate === 1) {
      const ruiM = await runRuiMonthly(db, apiKey)
      result.rui.monthly = ruiM.ok && !ruiM.error?.includes('スキップ')
      result.rui.costUsd += ruiM.costUsd
      if (!ruiM.ok && ruiM.error) result.rui.errors.push(ruiM.error)
      if (result.rui.monthly) await logWorker(db, 'rui', 'monthly_analysis', true, { reportId: ruiM.reportId, costUsd: ruiM.costUsd })
    }
  } catch (e: any) {
    result.rui.errors.push(e?.message || 'Rui実行エラー')
  } finally {
    await setWorkerIdle(db, 'rui')
  }

  // ========== Phase 8: Nana 日次レポート(最後に全体を集計) ==========
  try {
    await setWorkerWorking(db, 'nana', '日次レポートを作成中')
    const nana = await runNanaReport(db, apiKey)
    result.nana = { reported: nana.ok, costUsd: nana.costUsd, error: nana.error }
    await logWorker(db, 'nana', 'daily_report', nana.ok, { reportId: nana.reportId, pending: nana.pendingCount, stale: nana.stalePending, costUsd: nana.costUsd, error: nana.error })
  } catch (e: any) {
    result.nana.error = e?.message
  } finally {
    await setWorkerIdle(db, 'nana')
  }

  result.totalCostUsd =
    result.alex.costUsd + result.riko.costUsd + result.competitor.costUsd + result.kai.costUsd + result.yuto.costUsd +
    result.aki.costUsd + result.noteDiagrams.costUsd + result.note.costUsd + result.noteCover.costUsd + result.monthlyNote.costUsd +
    result.rui.costUsd + result.nana.costUsd + result.recycle.costUsd
  result.ok = result.yuto.postsCreated > 0
  if (!result.ok) result.error = 'Yuto執筆が全件失敗しました'
  return result
}

// ============================================================
// 毎時cronエントリ: 時間帯で処理を振り分け
//  - JST 5時台: フルパイプライン(1日1回ガード付き)
//  - 毎時: Sora自動予約投稿(承認済みの時刻到来分をXへ)
// ============================================================
export interface HourlyTickResult {
  ok: boolean
  mode: 'pipeline' | 'publish_only'
  pipeline?: PipelineResult
  sora: SoraPublishResult
  replies: { collect: ReplyCollectResult; publish: ReplyPublishResult }
  selfRepost?: SelfRepostResult
  error?: string
}

// ④ セルフリポスト: 当日公開済みのインプ上位1本を夜(JST21時)に自動RTして再露出
// - 1日1本 / 同じ投稿は二度とRTしない(self_reposted_atで追跡)
// - Xキー未設定なら何もしない(skippedNoCreds)
export interface SelfRepostResult {
  ok: boolean
  reposted: boolean
  skippedNoCreds: boolean
  postId?: string
  tweetId?: string
  impressions?: number
  error?: string
}

export async function runSelfRepost(
  db: D1Database,
  env: Record<string, string | undefined>,
): Promise<SelfRepostResult> {
  const result: SelfRepostResult = { ok: true, reposted: false, skippedNoCreds: false }
  const creds = getXCredentials(env)
  if (!creds) {
    result.skippedNoCreds = true
    return result
  }
  try {
    // 1日1本ガード: 今日(JST)既にRT済みならスキップ
    const already = await db
      .prepare("SELECT post_id FROM x_posts WHERE self_reposted_at IS NOT NULL AND date(self_reposted_at, '+9 hours') = date('now', '+9 hours') LIMIT 1")
      .first()
    if (already) return result

    // 当日(JST)公開済み・未RT・tweet_idありの候補があるか先に確認(なければAPIコスト0で終了)
    const anyCandidate = await db
      .prepare(
        `SELECT post_id FROM x_posts
         WHERE published_at IS NOT NULL AND buffer_id IS NOT NULL
           AND self_reposted_at IS NULL
           AND date(published_at, '+9 hours') = date('now', '+9 hours')
         LIMIT 1`,
      )
      .first()
    if (!anyCandidate) return result // 当日の公開済み投稿なし

    // userIdはapp_settingsキャッシュ優先(User Read $0.010節約)
    let userId = ''
    try {
      const cached: any = await db.prepare("SELECT value FROM app_settings WHERE key = 'x_user_id'").first()
      if (cached?.value) userId = JSON.parse(cached.value).userId || ''
    } catch { /* なければ取得 */ }
    if (!userId) {
      const prof = await fetchMyProfile(creds)
      if (!prof.ok || !prof.userId) {
        result.ok = false
        result.error = `プロフィール取得失敗: ${prof.error}`
        return result
      }
      userId = prof.userId
      await db.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('x_user_id', ?, CURRENT_TIMESTAMP)")
        .bind(JSON.stringify({ userId, username: prof.username || '' })).run()
    }

    // 当日分の実インプを取得して書き戻す(Owned Read 約$0.05)。
    // 朝のKPI収集は前日までのデータのため、これがないと当日投稿は全てimpressions=0で
    // 「インプ上位」でなく「最初の投稿」が常に選ばれてしまう。
    // 取得失敗時はDB上の値(=0の可能性大)にフォールバックして続行。
    try {
      const metrics = await fetchMyTweetsMetrics(creds, userId)
      if (metrics.ok) {
        for (const t of metrics.perTweet || []) {
          try {
            await db.prepare('UPDATE x_posts SET impressions = ?, engagements = ? WHERE buffer_id = ?')
              .bind(t.impressions, t.engagements, t.tweetId).run()
          } catch { /* 個別失敗は無視 */ }
        }
      }
    } catch { /* メトリクス取得失敗でもRT自体は続行 */ }

    // 書き戻し後のインプ最上位1本を選定
    const top: any = await db
      .prepare(
        `SELECT post_id, buffer_id, impressions FROM x_posts
         WHERE published_at IS NOT NULL AND buffer_id IS NOT NULL
           AND self_reposted_at IS NULL
           AND date(published_at, '+9 hours') = date('now', '+9 hours')
         ORDER BY impressions DESC, published_at ASC LIMIT 1`,
      )
      .first()
    if (!top?.buffer_id) return result

    const rt = await retweet(creds, userId, String(top.buffer_id))
    if (!rt.ok) {
      result.ok = false
      result.error = rt.error
      return result
    }
    await db.prepare("UPDATE x_posts SET self_reposted_at = datetime('now') WHERE post_id = ?").bind(top.post_id).run()
    result.reposted = true
    result.postId = String(top.post_id)
    result.tweetId = String(top.buffer_id)
    result.impressions = Number(top.impressions || 0)
  } catch (e: any) {
    result.ok = false
    result.error = e?.message || 'セルフリポストエラー'
  }
  return result
}

export async function runHourlyTick(
  db: D1Database,
  r2: R2Bucket,
  env: Record<string, string | undefined>,
): Promise<HourlyTickResult> {
  const jstHour = new Date(Date.now() + 9 * 3600 * 1000).getUTCHours()
  const jstToday = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
  const result: HourlyTickResult = {
    ok: true,
    mode: 'publish_only',
    sora: { ok: true, published: 0, skippedNoCreds: false, details: [], errors: [] },
    replies: {
      collect: { ok: true, fetched: 0, drafted: 0, skippedNoCreds: false, costUsd: 0, errors: [] },
      publish: { ok: true, published: 0, skippedNoCreds: false, details: [], errors: [] },
    },
  }

  // JST 5時台のみパイプライン(同日重複実行ガード: 今日分のauto_write成功ログがあればスキップ)
  if (jstHour === 5) {
    const already = await db
      .prepare(
        `SELECT id FROM worker_logs
         WHERE worker_name = 'yuto' AND action = 'auto_write' AND status = 'success'
           AND date(finished_at, '+9 hours') = ? LIMIT 1`,
      )
      .bind(jstToday).first()
    if (!already) {
      result.mode = 'pipeline'
      result.pipeline = await runDailyPipeline(db, r2, String(env.OPENAI_API_KEY || ''), env)
      result.ok = result.pipeline.ok
      if (!result.pipeline.ok) result.error = result.pipeline.error
    }
  }

  // 毎時: 時刻到来分の自動投稿(Xキー未設定なら何もしない)
  try {
    result.sora = await runSoraScheduledPublish(db, r2, env)
  } catch (e: any) {
    result.sora.errors.push(e?.message || 'Sora実行エラー')
  }

  // P1-4: リプライ自動返信 — JST 8/12/18/22時にメンション回収→下書き生成(1日4回でRead課金を抑制)、
  //        承認済み返信の送信は毎時(Xキー未設定なら何もしない)
  try {
    if ([8, 12, 18, 22].includes(jstHour)) {
      result.replies.collect = await collectMentionsAndDraft(db, String(env.OPENAI_API_KEY || ''), env)
      if (!result.replies.collect.skippedNoCreds && (result.replies.collect.fetched > 0 || result.replies.collect.errors.length > 0)) {
        await db.prepare(
          "INSERT INTO worker_logs (worker_name, action, status, output_json, finished_at) VALUES ('sora', 'mention_collect', ?, ?, CURRENT_TIMESTAMP)",
        ).bind(result.replies.collect.ok ? 'success' : 'failed', JSON.stringify({ fetched: result.replies.collect.fetched, drafted: result.replies.collect.drafted, costUsd: result.replies.collect.costUsd, errors: result.replies.collect.errors.slice(0, 3) })).run()
      }
    }
  } catch (e: any) {
    result.replies.collect.errors.push(e?.message || 'メンション収集エラー')
  }
  try {
    result.replies.publish = await publishApprovedReplies(db, env)
  } catch (e: any) {
    result.replies.publish.errors.push(e?.message || '返信送信エラー')
  }

  // ④ JST 21時: 当日インプ上位投稿をセルフRT(夜の再露出でインプ上乗せ。Xキー未設定なら何もしない)
  try {
    if (jstHour === 21) {
      result.selfRepost = await runSelfRepost(db, env)
      if (!result.selfRepost.skippedNoCreds && (result.selfRepost.reposted || result.selfRepost.error)) {
        await logWorker(db, 'sora', 'self_repost', result.selfRepost.ok, {
          reposted: result.selfRepost.reposted,
          postId: result.selfRepost.postId,
          tweetId: result.selfRepost.tweetId,
          impressions: result.selfRepost.impressions,
          error: result.selfRepost.error,
        })
      }
    }
  } catch (e: any) {
    result.selfRepost = { ok: false, reposted: false, skippedNoCreds: false, error: e?.message || 'セルフリポストエラー' }
  }

  return result
}
