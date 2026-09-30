import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { runQaCheck, FORBIDDEN_RULES } from './qa-rules'
import { embedAffiliateLinks, resolveClickBase, suggestAnnotations, type AffiliateLink, type GlossaryEntry } from './affiliate'
import { computeCostPlan } from './model-plan'
import { callOpenAI, YUTO_SYSTEM, MIO_SYSTEM } from './llm'
import { buildImagePrompt, generateImage, qaImage, IMAGE_SIZE, IMAGE_COST_USD, type ImagePurpose } from './image-gen'
import { getXCredentials, xWeightedLength, X_WEIGHT_LIMIT } from './x-api'
import { runRikoCrawl } from './riko'
import { runDailyPipeline, runHourlyTick, runSelfRepost, SLOT_TABLE } from './cron'
import { publishPostToX, runSoraScheduledPublish } from './sora'
import { collectMentionsAndDraft, publishApprovedReplies } from './replies'
import { runNanaReport } from './nana'
import { getAuthState, registerUser, loginUser, logoutUser, sessionCookie, clearSessionCookie, parseSessionCookie, ALLOWED_EMAILS } from './auth'

type Bindings = {
  DB: D1Database
  R2: R2Bucket
  OPENAI_API_KEY?: string
  X_API_KEY?: string
  X_API_SECRET?: string
  X_ACCESS_TOKEN?: string
  X_ACCESS_TOKEN_SECRET?: string
  CRON_SECRET?: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors())

// ============================================================
// 認証(メールアドレス+パスワード / セッションCookie)
// ============================================================

// 認証不要パス: 認証API自体と cron(CRON_SECRETで別途保護)
const AUTH_EXEMPT = ['/api/auth/status', '/api/auth/register', '/api/auth/login', '/api/auth/logout', '/api/cron/run']

app.use('/api/*', async (c, next) => {
  if (AUTH_EXEMPT.includes(new URL(c.req.url).pathname)) return next()
  const token = parseSessionCookie(c.req.header('Cookie'))
  const auth = await getAuthState(c.env.DB, token)
  if (!auth.email) return c.json({ error: 'unauthorized', needLogin: true }, 401)
  return next()
})

app.get('/api/auth/status', async (c) => {
  const token = parseSessionCookie(c.req.header('Cookie'))
  const auth = await getAuthState(c.env.DB, token)
  return c.json({ registered: auth.registered, loggedIn: !!auth.email, email: auth.email })
})

app.post('/api/auth/register', async (c) => {
  const { email, password } = await c.req.json<{ email: string; password: string }>()
  const result = await registerUser(c.env.DB, email || '', password || '')
  if (!result.ok) return c.json({ error: result.error }, 400)
  // 登録後そのままログイン
  const login = await loginUser(c.env.DB, email, password)
  if (login.ok && login.token) c.header('Set-Cookie', sessionCookie(login.token))
  return c.json({ ok: true })
})

app.post('/api/auth/login', async (c) => {
  const { email, password } = await c.req.json<{ email: string; password: string }>()
  const result = await loginUser(c.env.DB, email || '', password || '')
  if (!result.ok) return c.json({ error: result.error }, 401)
  c.header('Set-Cookie', sessionCookie(result.token!))
  return c.json({ ok: true })
})

app.post('/api/auth/logout', async (c) => {
  const token = parseSessionCookie(c.req.header('Cookie'))
  if (token) await logoutUser(c.env.DB, token)
  c.header('Set-Cookie', clearSessionCookie())
  return c.json({ ok: true })
})

// ============================================================
// Virtual Office API
// ============================================================

// オフィス全体の状態(ワーカー + 承認待ち件数 + 本日KPI)
app.get('/api/office', async (c) => {
  const { DB } = c.env
  const [workers, tasks, kpi, pendingApprovals, recentLogs, sessionStatus, pendingReplies] = await Promise.all([
    DB.prepare('SELECT * FROM worker_status ORDER BY rowid').all(),
    DB.prepare("SELECT * FROM task_queue WHERE status IN ('queued','processing') ORDER BY priority LIMIT 20").all(),
    DB.prepare("SELECT * FROM kpi_daily ORDER BY date DESC LIMIT 2").all(),
    DB.prepare("SELECT gate_type, COUNT(*) as cnt FROM approval_queue WHERE responded_at IS NULL GROUP BY gate_type").all(),
    DB.prepare('SELECT * FROM worker_logs ORDER BY started_at DESC LIMIT 10').all(),
    DB.prepare("SELECT key, value FROM app_settings WHERE key IN ('note_session_status','note_session_checked_at')").all(),
    // ⑤ 返信承認待ち件数(x_replies未整備でも落とさない)
    DB.prepare("SELECT COUNT(*) AS cnt FROM x_replies WHERE approval_status = 'pending' AND draft_body != ''").first<{ cnt: number }>().catch(() => ({ cnt: 0 }))
  ])
  const ss: Record<string, string> = {}
  for (const r of (sessionStatus.results || []) as any[]) ss[r.key] = r.value
  return c.json({
    workers: workers.results,
    tasks: tasks.results,
    kpi_today: kpi.results?.[0] ?? null,
    kpi_yesterday: kpi.results?.[1] ?? null,
    pending_approvals: pendingApprovals.results,
    pending_replies: Number((pendingReplies as any)?.cnt || 0),
    recent_logs: recentLogs.results,
    note_session: { status: ss['note_session_status'] || 'unset', checked_at: ss['note_session_checked_at'] || null }
  })
})

// ワーカー詳細(ログ履歴)
app.get('/api/workers/:name', async (c) => {
  const { DB } = c.env
  const name = c.req.param('name')
  const [worker, logs] = await Promise.all([
    DB.prepare('SELECT * FROM worker_status WHERE worker_name = ?').bind(name).first(),
    DB.prepare('SELECT * FROM worker_logs WHERE worker_name = ? ORDER BY started_at DESC LIMIT 30').bind(name).all()
  ])
  if (!worker) return c.notFound()
  return c.json({ worker, logs: logs.results })
})

// ============================================================
// 承認ゲート① 週次企画(月曜朝)
// ============================================================

app.get('/api/topics', async (c) => {
  const { DB } = c.env
  const status = c.req.query('status') ?? 'pending'
  const rows = await DB.prepare('SELECT * FROM topic_candidates WHERE status = ? ORDER BY CASE urgency WHEN "high" THEN 0 WHEN "medium" THEN 1 ELSE 2 END, created_at DESC').bind(status).all()
  return c.json({ topics: rows.results })
})

app.post('/api/topics/:id/decision', async (c) => {
  const { DB } = c.env
  const id = c.req.param('id')
  const { decision } = await c.req.json<{ decision: 'approved' | 'rejected' }>()
  if (!['approved', 'rejected'].includes(decision)) return c.json({ error: 'invalid decision' }, 400)
  await DB.prepare('UPDATE topic_candidates SET status = ? WHERE topic_id = ?').bind(decision, id).run()
  // 承認されたら Kai(翻訳)へタスク投入
  if (decision === 'approved') {
    await DB.prepare("INSERT INTO task_queue (worker_name, task_type, payload, priority) VALUES ('kai', 'translate', ?, 2)")
      .bind(JSON.stringify({ topic_id: id })).run()
  }
  return c.json({ ok: true, topic_id: id, decision })
})

// ============================================================
// 承認ゲート② 日次X投稿12本(毎晩22:00)
// ============================================================

app.get('/api/posts', async (c) => {
  const { DB } = c.env
  const status = c.req.query('status') ?? 'pending'
  const rows = await DB.prepare('SELECT * FROM x_posts WHERE approval_status = ? ORDER BY slot_number').bind(status).all()
  return c.json({ posts: rows.results })
})

app.post('/api/posts/:id/decision', async (c) => {
  const { DB } = c.env
  const id = c.req.param('id')
  const { decision, reason } = await c.req.json<{ decision: 'approved' | 'rejected'; reason?: string }>()
  if (!['approved', 'rejected'].includes(decision)) return c.json({ error: 'invalid decision' }, 400)
  await DB.prepare('UPDATE x_posts SET approval_status = ? WHERE post_id = ?').bind(decision, id).run()
  if (decision === 'approved') {
    // Sora へ Buffer予約タスク投入
    await DB.prepare("INSERT INTO task_queue (worker_name, task_type, payload, priority) VALUES ('sora', 'buffer_schedule', ?, 1)")
      .bind(JSON.stringify({ post_id: id })).run()
  } else if (reason) {
    // 差戻理由を Yuto へ
    await DB.prepare("INSERT INTO task_queue (worker_name, task_type, payload, priority) VALUES ('yuto', 'rewrite', ?, 1)")
      .bind(JSON.stringify({ post_id: id, reason })).run()
  }
  return c.json({ ok: true, post_id: id, decision })
})

// 一括承認(QAがOKの投稿のみ)
app.post('/api/posts/approve-all', async (c) => {
  const { DB } = c.env
  const result = await DB.prepare("UPDATE x_posts SET approval_status = 'approved' WHERE approval_status = 'pending' AND qa_status = 'ok'").run()
  const approved = result.meta.changes ?? 0
  if (approved > 0) {
    await DB.prepare("INSERT INTO task_queue (worker_name, task_type, payload, priority) VALUES ('sora', 'buffer_schedule_batch', ?, 1)")
      .bind(JSON.stringify({ approved_count: approved })).run()
    await DB.prepare("UPDATE approval_queue SET responded_at = CURRENT_TIMESTAMP, decision = 'approved' WHERE gate_type = 'daily_posts' AND responded_at IS NULL").run()
  }
  const skipped = await DB.prepare("SELECT COUNT(*) as cnt FROM x_posts WHERE approval_status = 'pending'").first<{ cnt: number }>()
  return c.json({ ok: true, approved, skipped: skipped?.cnt ?? 0 })
})

// ============================================================
// リプライ自動返信 (P1-4): 下書き一覧・承認・却下
// ============================================================

app.get('/api/replies', async (c) => {
  const { DB } = c.env
  const status = c.req.query('status') ?? 'pending'
  try {
    const rows = await DB.prepare(
      "SELECT * FROM x_replies WHERE approval_status = ? AND draft_body != '' ORDER BY created_at DESC LIMIT 50",
    ).bind(status).all()
    return c.json({ replies: rows.results })
  } catch {
    return c.json({ replies: [] }) // テーブル未作成でも壊れない
  }
})

app.post('/api/replies/:id/decision', async (c) => {
  const { DB } = c.env
  const id = c.req.param('id')
  const { decision, body } = await c.req.json<{ decision: 'approved' | 'rejected'; body?: string }>()
  if (!['approved', 'rejected'].includes(decision)) return c.json({ error: 'invalid decision' }, 400)
  if (decision === 'approved') {
    // 承認時の文字数ガード: weighted 280超は送信が必ず失敗するため承認自体を拒否
    // (編集後本文があればそれを、なければ既存の下書きを検証)
    let finalBody = body && body.trim() ? body.trim() : ''
    if (!finalBody) {
      const row = await DB.prepare('SELECT draft_body FROM x_replies WHERE reply_id = ?').bind(id).first<{ draft_body: string }>()
      finalBody = String(row?.draft_body || '')
    }
    const weight = xWeightedLength(finalBody)
    if (weight > X_WEIGHT_LIMIT) {
      return c.json({ error: `文字数が上限を超えています(${weight}/280 — 日本語約140字)。短く編集してから承認してください`, weight, limit: X_WEIGHT_LIMIT }, 400)
    }
  }
  if (decision === 'approved' && body && body.trim()) {
    // 承認時に本文を編集して送る場合(検証済みなのでqa_statusもokに引き上げ)
    await DB.prepare("UPDATE x_replies SET approval_status = ?, draft_body = ?, qa_status = 'ok' WHERE reply_id = ?").bind(decision, body.trim(), id).run()
  } else {
    await DB.prepare('UPDATE x_replies SET approval_status = ? WHERE reply_id = ?').bind(decision, id).run()
  }
  return c.json({ ok: true, reply_id: id, decision })
})

// 返信一括承認 (QA通過分のみ)
app.post('/api/replies/approve-all', async (c) => {
  const { DB } = c.env
  const result = await DB.prepare(
    "UPDATE x_replies SET approval_status = 'approved' WHERE approval_status = 'pending' AND qa_status = 'ok' AND draft_body != ''",
  ).run()
  return c.json({ ok: true, approved: result.meta.changes ?? 0 })
})

// ============================================================
// 承認ゲート③ 有料note公開直前
// ============================================================

app.get('/api/notes', async (c) => {
  const { DB } = c.env
  const rows = await DB.prepare('SELECT article_id, topic_id, title, type, price_yen, approval_status, qa_status, published_at, view_count, sales_count, revenue_yen, note_url, cover_image_id, created_at FROM note_articles ORDER BY created_at DESC').all()
  return c.json({ articles: rows.results })
})

app.get('/api/notes/:id', async (c) => {
  const { DB } = c.env
  const id = c.req.param('id')
  const row: any = await DB.prepare('SELECT * FROM note_articles WHERE article_id = ?').bind(id).first()
  if (!row) return c.notFound()
  // 記事に紐づく画像 (カバー + 本文用図解)
  let images: any[] = []
  try {
    const imgRows = await DB.prepare(
      `SELECT image_id, purpose, title_text, qa_status, created_at FROM generated_images
       WHERE article_id = ? OR image_id = ? ORDER BY created_at ASC`,
    ).bind(id, row.cover_image_id || '').all()
    images = (imgRows.results || []) as any[]
  } catch { /* article_id列が未追加の環境でも記事表示は継続 */ }
  return c.json({ article: row, images })
})

app.post('/api/notes/:id/publish', async (c) => {
  const { DB } = c.env
  const id = c.req.param('id')
  const article = await DB.prepare('SELECT * FROM note_articles WHERE article_id = ?').bind(id).first<any>()
  if (!article) return c.notFound()
  if (article.qa_status === 'ng') return c.json({ error: 'QA判定がNGのため公開できません' }, 400)
  await DB.prepare("UPDATE note_articles SET approval_status = 'published', published_at = CURRENT_TIMESTAMP WHERE article_id = ?").bind(id).run()
  await DB.prepare("UPDATE approval_queue SET responded_at = CURRENT_TIMESTAMP, decision = 'approved' WHERE gate_type = 'paid_note' AND responded_at IS NULL AND target_ids LIKE ?").bind(`%${id}%`).run()
  // note_publisher タスク投入(本番では Browser Rendering)
  await DB.prepare("INSERT INTO task_queue (worker_name, task_type, payload, priority) VALUES ('sora', 'note_publish', ?, 1)")
    .bind(JSON.stringify({ article_id: id })).run()
  return c.json({ ok: true, article_id: id })
})

// Riko競合リサーチの手動実行(通常は毎週月曜に自動実行)
app.post('/api/reports/competitor/run', async (c) => {
  const { runRikoCompetitorResearch } = await import('./riko')
  const result = await runRikoCompetitorResearch(c.env.DB, c.env.OPENAI_API_KEY || '')
  return c.json(result, result.ok ? 200 : 502)
})

// 月次まとめnote(¥500)の手動生成(通常は毎月1日に自動実行。テスト・再生成用)
app.post('/api/notes/monthly/run', async (c) => {
  const { runMonthlySummaryNote } = await import('./note-writer')
  const result = await runMonthlySummaryNote(c.env.DB, c.env.OPENAI_API_KEY || '')
  return c.json(result, result.ok ? 200 : 502)
})

// note実URLの登録(公開後に取締役が貼り付け → 枠11の告知投稿が実URL連動になる)
app.post('/api/notes/:id/url', async (c) => {
  const { DB } = c.env
  const id = c.req.param('id')
  const { note_url } = await c.req.json<{ note_url: string }>()
  if (!note_url || !/^https:\/\/note\.com\//.test(note_url)) {
    return c.json({ error: 'note.com のURLを入力してください(例: https://note.com/xxx/n/xxxx)' }, 400)
  }
  await DB.prepare('UPDATE note_articles SET note_url = ? WHERE article_id = ?').bind(note_url.trim(), id).run()
  return c.json({ ok: true, article_id: id, note_url: note_url.trim() })
})

// 記事別売上の手動入力(noteダッシュボードの数字を反映 → Ruiが売れ筋分析に使用)
app.post('/api/notes/:id/stats', async (c) => {
  const { DB } = c.env
  const id = c.req.param('id')
  const { view_count, sales_count, revenue_yen } = await c.req.json<{ view_count?: number; sales_count?: number; revenue_yen?: number }>()
  await DB.prepare(
    `UPDATE note_articles SET
       view_count = COALESCE(?, view_count),
       sales_count = COALESCE(?, sales_count),
       revenue_yen = COALESCE(?, revenue_yen)
     WHERE article_id = ?`,
  ).bind(view_count ?? null, sales_count ?? null, revenue_yen ?? null, id).run()
  return c.json({ ok: true, article_id: id })
})

// ============================================================
// KPI
// ============================================================

// AIモデル構成 & コスト試算 (OpenAI移行プラン)
app.get('/api/models/cost', (c) => {
  return c.json(computeCostPlan())
})

// ============================================================
// 実LLM接続 (OpenAI GPT-5ファミリ)
// ============================================================

// LLM接続状態
app.get('/api/llm/status', (c) => {
  const key = c.env.OPENAI_API_KEY
  return c.json({
    connected: !!key,
    provider: 'OpenAI',
    keyHint: key ? `sk-...${key.slice(-4)}` : null,
  })
})

// Yuto(ライター/gpt-5)に新規投稿を執筆させる
app.post('/api/llm/write', async (c) => {
  const { DB } = c.env
  const { theme, slot, save } = await c.req.json<{ theme: string; slot?: number; save?: boolean }>()
  if (!theme?.trim()) return c.json({ error: 'テーマを入力してください' }, 400)

  // 用語集をプロンプトに注入(注釈の一貫性確保)
  const gl = await DB.prepare('SELECT term, annotation FROM glossary LIMIT 30').all()
  const glossaryNote = (gl.results as any[]).map((g) => `※${g.term}=${g.annotation}`).join('\n')

  const userPrompt = `以下のテーマでX投稿を1本執筆してください。\n\nテーマ: ${theme}\n${slot ? `投稿枠: 枠${slot}` : ''}\n\n▓参考: 既存の用語注釈集(同じ固有名詞はこの注釈を使う)\n${glossaryNote}`

  const result = await callOpenAI(c.env.OPENAI_API_KEY || '', 'gpt-5', YUTO_SYSTEM, userPrompt, 3000)
  if (!result.ok) return c.json({ error: result.error }, 502)

  // キーワードQAも自動実行
  const qa = runQaCheck(result.content, false)

  let savedPostId: string | null = null
  if (save) {
    savedPostId = `p-llm-${Date.now()}`
    await DB.prepare(
      "INSERT INTO x_posts (post_id, slot_number, scheduled_at, body, approval_status, qa_status, qa_issues) VALUES (?, ?, datetime('now', '+1 day'), ?, 'pending', ?, ?)"
    ).bind(savedPostId, slot || 1, result.content, qa.status, JSON.stringify(qa.issues)).run()
    await DB.prepare("INSERT INTO worker_logs (worker_name, action, status, output_json, finished_at) VALUES ('yuto', 'llm_write', 'success', ?, CURRENT_TIMESTAMP)")
      .bind(`OpenAI(gpt-5)で執筆: ${theme.slice(0, 40)}`).run()
  }

  return c.json({
    draft: result.content,
    model: result.model,
    usage: result.usage,
    costUsd: result.costUsd,
    qa,
    savedPostId,
  })
})

// Mio(QA/gpt-5-mini)に法務チェックさせる(キーワードエンジン+LLMの二重チェック)
app.post('/api/llm/qa', async (c) => {
  const { text } = await c.req.json<{ text: string }>()
  if (!text?.trim()) return c.json({ error: 'テキストを入力してください' }, 400)

  const keywordQa = runQaCheck(text, /\bhttps?:\/\//.test(text))
  const result = await callOpenAI(c.env.OPENAI_API_KEY || '', 'gpt-5-mini', MIO_SYSTEM, `以下の投稿文を審査してください:\n\n${text}`, 2000)
  if (!result.ok) return c.json({ error: result.error, keywordQa }, 502)

  let llmVerdict: any = null
  try {
    const jsonText = result.content.replace(/^```json?\s*/,'').replace(/```\s*$/,'').trim()
    llmVerdict = JSON.parse(jsonText)
  } catch {
    llmVerdict = { verdict: 'unknown', raw: result.content }
  }

  return c.json({
    keywordQa,
    llm: llmVerdict,
    model: result.model,
    usage: result.usage,
    costUsd: result.costUsd,
  })
})

// ============================================================
// Aki: 画像生成 (gpt-image-2 → R2保存) + Mio: 画像QA
// ============================================================

// 生成済み画像一覧
app.get('/api/images', async (c) => {
  const { DB } = c.env
  const rows = await DB.prepare('SELECT * FROM generated_images ORDER BY created_at DESC LIMIT 50').all()
  return c.json({ images: rows.results })
})

// R2から画像配信
app.get('/api/images/:id/file', async (c) => {
  const { DB, R2 } = c.env
  const img: any = await DB.prepare('SELECT r2_key FROM generated_images WHERE image_id = ?').bind(c.req.param('id')).first()
  if (!img) return c.notFound()
  const obj = await R2.get(img.r2_key)
  if (!obj) return c.notFound()
  return new Response(obj.body, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } })
})

// Akiに画像を生成させる → R2保存 → Mio画像QA自動実行
app.post('/api/images/generate', async (c) => {
  const { DB, R2 } = c.env
  const { purpose, title, extra, post_id, skip_qa } = await c.req.json<{ purpose: ImagePurpose; title: string; extra?: string; post_id?: string; skip_qa?: boolean }>()
  if (!title?.trim()) return c.json({ error: 'タイトルテキストを入力してください' }, 400)
  const p: ImagePurpose = ['thumbnail', 'infographic', 'note_cover'].includes(purpose) ? purpose : 'thumbnail'

  const prompt = buildImagePrompt(p, title, extra)
  const gen = await generateImage(c.env.OPENAI_API_KEY || '', prompt, IMAGE_SIZE[p])
  if (!gen.ok) return c.json({ error: gen.error }, 502)

  // R2保存
  const imageId = `img-${Date.now()}`
  const r2Key = `images/${imageId}.png`
  const binary = Uint8Array.from(atob(gen.b64!), (ch) => ch.charCodeAt(0))
  await R2.put(r2Key, binary, { httpMetadata: { contentType: 'image/png' } })

  // Mio画像QA (スキップ可)
  let qa: any = { verdict: 'pending' }
  let qaCost = 0
  if (!skip_qa) {
    const qaRes = await qaImage(c.env.OPENAI_API_KEY || '', gen.b64!, title)
    if (qaRes.ok) {
      qa = { verdict: qaRes.verdict, issues: qaRes.issues || [], summary: qaRes.summary, text_readable: qaRes.text_readable }
      qaCost = qaRes.costUsd || 0
    } else {
      qa = { verdict: 'pending', error: qaRes.error }
    }
  }

  const totalCost = IMAGE_COST_USD + qaCost
  await DB.prepare(
    'INSERT INTO generated_images (image_id, post_id, purpose, prompt, title_text, r2_key, model, qa_status, qa_issues, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(imageId, post_id || null, p, prompt, title, r2Key, 'gpt-image-2', qa.verdict === 'unknown' ? 'pending' : qa.verdict, JSON.stringify(qa.issues || []), totalCost).run()

  await DB.prepare("INSERT INTO worker_logs (worker_name, action, status, output_json, finished_at) VALUES ('aki', 'image_generate', 'success', ?, CURRENT_TIMESTAMP)")
    .bind(`gpt-image-2で生成: ${title.slice(0, 40)} (QA: ${qa.verdict})`).run()

  return c.json({ image_id: imageId, url: `/api/images/${imageId}/file`, prompt, qa, costUsd: totalCost })
})

// 既存画像のMio QA再実行
app.post('/api/images/:id/qa', async (c) => {
  const { DB, R2 } = c.env
  const id = c.req.param('id')
  const img: any = await DB.prepare('SELECT * FROM generated_images WHERE image_id = ?').bind(id).first()
  if (!img) return c.json({ error: 'not found' }, 404)
  const obj = await R2.get(img.r2_key)
  if (!obj) return c.json({ error: '画像ファイルが見つかりません' }, 404)
  const buf = await obj.arrayBuffer()
  let b64 = ''
  const bytes = new Uint8Array(buf)
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    b64 += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  b64 = btoa(b64)

  const qaRes = await qaImage(c.env.OPENAI_API_KEY || '', b64, img.title_text || '')
  if (!qaRes.ok) return c.json({ error: qaRes.error }, 502)

  await DB.prepare('UPDATE generated_images SET qa_status = ?, qa_issues = ? WHERE image_id = ?')
    .bind(qaRes.verdict === 'unknown' ? 'pending' : qaRes.verdict, JSON.stringify(qaRes.issues || []), id).run()
  await DB.prepare("INSERT INTO worker_logs (worker_name, action, status, output_json, finished_at) VALUES ('mio', 'image_qa', 'success', ?, CURRENT_TIMESTAMP)")
    .bind(`画像QA: ${id} → ${qaRes.verdict}`).run()

  return c.json({ image_id: id, verdict: qaRes.verdict, issues: qaRes.issues || [], summary: qaRes.summary, text_readable: qaRes.text_readable, costUsd: qaRes.costUsd })
})

// 画像削除
app.delete('/api/images/:id', async (c) => {
  const { DB, R2 } = c.env
  const id = c.req.param('id')
  const img: any = await DB.prepare('SELECT r2_key FROM generated_images WHERE image_id = ?').bind(id).first()
  if (img) await R2.delete(img.r2_key)
  await DB.prepare('DELETE FROM generated_images WHERE image_id = ?').bind(id).run()
  return c.json({ ok: true })
})

// ============================================================
// X API 直接接続 (OAuth 1.0a)
// ============================================================

app.get('/api/x/status', (c) => {
  const creds = getXCredentials(c.env as any)
  return c.json({ connected: !!creds, required: ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'] })
})

// 承認済み投稿をXへ即時投稿 (画像付き対応)
app.post('/api/posts/:id/publish-x', async (c) => {
  const { DB, R2 } = c.env
  const id = c.req.param('id')
  const creds = getXCredentials(c.env as any)
  if (!creds) return c.json({ error: 'X APIキーが未設定です。X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_TOKEN_SECRET の4つのシークレット登録が必要です' }, 400)

  const post: any = await DB.prepare('SELECT * FROM x_posts WHERE post_id = ?').bind(id).first()
  if (!post) return c.json({ error: 'not found' }, 404)
  if (post.approval_status !== 'approved') return c.json({ error: '承認済みの投稿のみ公開できます。先に承認してください' }, 400)
  if (post.qa_status === 'ng') return c.json({ error: 'QA判定NGの投稿は公開できません' }, 400)
  if (post.published_at) return c.json({ error: 'すでに公開済みです' }, 400)

  // 共通投稿ロジック (画像添付+引用RT+生存確認込み)
  const result = await publishPostToX(DB, R2, creds, post)
  if (!result.ok) return c.json({ error: `X投稿失敗: ${result.error}` }, 502)

  await DB.prepare("INSERT INTO worker_logs (worker_name, action, status, output_json, finished_at) VALUES ('sora', 'x_publish', 'success', ?, CURRENT_TIMESTAMP)")
    .bind(`Xへ投稿完了: ${result.tweetUrl}${result.quoted ? ' (引用RT)' : ''}`).run()

  return c.json({ ok: true, tweet_id: result.tweetId, tweet_url: result.tweetUrl, with_image: result.withImage, quoted: result.quoted })
})

// 既存投稿をYutoにリライトさせる(QA指摘を反映)
app.post('/api/posts/:id/rewrite', async (c) => {
  const { DB } = c.env
  const id = c.req.param('id')
  const post: any = await DB.prepare('SELECT * FROM x_posts WHERE post_id = ?').bind(id).first()
  if (!post) return c.json({ error: 'not found' }, 404)

  const issues = post.qa_issues ? JSON.parse(post.qa_issues) : []
  const issueText = issues.length
    ? issues.map((i: any) => `- ${i.law || ''} ${i.reason || i.message || ''}`).join('\n')
    : '(特になし。より読みやすく・法令遵守で磨いてください)'

  const userPrompt = `以下の投稿文を、QA指摘を解消するように書き直してください。元のネタ・構成は活かすこと。\n\n▓元の投稿:\n${post.body}\n\n▓QA指摘:\n${issueText}`
  const result = await callOpenAI(c.env.OPENAI_API_KEY || '', 'gpt-5', YUTO_SYSTEM, userPrompt, 3000)
  if (!result.ok) return c.json({ error: result.error }, 502)

  const qa = runQaCheck(result.content, result.content.includes('#PR'))
  await DB.prepare('UPDATE x_posts SET body = ?, qa_status = ?, qa_issues = ? WHERE post_id = ?')
    .bind(result.content, qa.status, JSON.stringify(qa.issues), id).run()
  await DB.prepare("INSERT INTO worker_logs (worker_name, action, status, output_json, finished_at) VALUES ('yuto', 'llm_rewrite', 'success', ?, CURRENT_TIMESTAMP)")
    .bind(`OpenAI(gpt-5)でリライト: ${id}`).run()

  return c.json({ post_id: id, body: result.content, qa, model: result.model, usage: result.usage, costUsd: result.costUsd })
})

// KPI手動入力(自動取得できない指標: インプレ・売上・メンバー数・アフィ収益。自動取得値は上書きしない)
app.post('/api/kpi/daily', async (c) => {
  const { DB } = c.env
  const b = await c.req.json<any>()
  const date = b.date || new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: '日付形式は YYYY-MM-DD' }, 400)
  const num = (v: any) => (v === undefined || v === null || v === '' ? null : Math.max(0, Math.floor(Number(v))))
  await DB.prepare(
    `INSERT INTO kpi_daily (date, x_followers, x_impressions_total, x_engagements_total, note_followers, note_paid_sales, membership_count, membership_revenue, affiliate_revenue)
     VALUES (?, COALESCE(?,0), COALESCE(?,0), COALESCE(?,0), COALESCE(?,0), COALESCE(?,0), COALESCE(?,0), COALESCE(?,0), COALESCE(?,0))
     ON CONFLICT(date) DO UPDATE SET
       x_followers = COALESCE(?, x_followers),
       x_impressions_total = COALESCE(?, x_impressions_total),
       x_engagements_total = COALESCE(?, x_engagements_total),
       note_followers = COALESCE(?, note_followers),
       note_paid_sales = COALESCE(?, note_paid_sales),
       membership_count = COALESCE(?, membership_count),
       membership_revenue = COALESCE(?, membership_revenue),
       affiliate_revenue = COALESCE(?, affiliate_revenue)`,
  ).bind(
    date,
    num(b.x_followers), num(b.x_impressions_total), num(b.x_engagements_total), num(b.note_followers),
    num(b.note_paid_sales), num(b.membership_count), num(b.membership_revenue), num(b.affiliate_revenue),
    num(b.x_followers), num(b.x_impressions_total), num(b.x_engagements_total), num(b.note_followers),
    num(b.note_paid_sales), num(b.membership_count), num(b.membership_revenue), num(b.affiliate_revenue),
  ).run()
  const row = await DB.prepare('SELECT * FROM kpi_daily WHERE date = ?').bind(date).first()
  return c.json({ ok: true, kpi: row })
})

// KPI自動収集を手動トリガ(テスト用・即時更新用)
app.post('/api/kpi/collect', async (c) => {
  const { collectKpiAuto } = await import('./kpi-collector')
  const result = await collectKpiAuto(c.env.DB, c.env as any)
  return c.json(result, result.ok || result.errors.length < 2 ? 200 : 502)
})

// アプリ設定(noteユーザー名・note sessionクッキーなど)
// ※ note_session_v5 の値は漏洩防止のためマスクして返す(登録有無と末尾4桁のみ)
app.get('/api/settings', async (c) => {
  const rows = await c.env.DB.prepare('SELECT key, value FROM app_settings').all()
  const settings: Record<string, string> = {}
  for (const r of (rows.results || []) as any[]) {
    if (r.key === 'note_session_v5') {
      settings['note_session_registered'] = r.value ? 'yes' : 'no'
      settings['note_session_tail'] = r.value ? String(r.value).slice(-4) : ''
    } else {
      settings[r.key] = r.value
    }
  }
  return c.json({ settings })
})

app.post('/api/settings', async (c) => {
  const { key, value } = await c.req.json<{ key: string; value: string }>()
  const ALLOWED = ['note_username', 'note_session_v5']
  if (!ALLOWED.includes(key)) return c.json({ error: `設定可能なキー: ${ALLOWED.join(', ')}` }, 400)
  let v = String(value || '').trim()

  if (key === 'note_session_v5') {
    // 貼り付けミス対策: 「_note_session_v5=値」形式やCookieヘッダー丸ごとにも対応
    const m = v.match(/_note_session_v5=([^;\s]+)/)
    if (m) v = m[1]
    if (!v) return c.json({ error: 'Cookie値が空です' }, 400)
    // 保存前に有効性を検証
    const { checkNoteSession, setSetting } = await import('./kpi-collector')
    const check = await checkNoteSession(v)
    if (!check.valid) {
      return c.json({ error: `Cookieの検証に失敗しました: ${check.error}。ブラウザでnoteにログインし直してから再度コピーしてください` }, 400)
    }
    await setSetting(c.env.DB, 'note_session_v5', v)
    await setSetting(c.env.DB, 'note_session_status', 'ok')
    await setSetting(c.env.DB, 'note_session_checked_at', new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' '))
    return c.json({ ok: true, key, verified: true, nickname: check.nickname || null })
  }

  await c.env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP`,
  ).bind(key, v, v).run()
  return c.json({ ok: true, key, value: v })
})

app.get('/api/kpi', async (c) => {
  const { DB } = c.env
  const days = Math.min(parseInt(c.req.query('days') ?? '14'), 90)
  const rows = await DB.prepare('SELECT * FROM kpi_daily ORDER BY date DESC LIMIT ?').bind(days).all()
  const history = (rows.results as any[]).reverse()
  const latest = history[history.length - 1]
  const prev = history[history.length - 2]
  return c.json({
    history,
    summary: latest && prev ? {
      followers_delta: latest.x_followers - prev.x_followers,
      revenue_today: (latest.note_paid_sales ?? 0) + (latest.membership_revenue ?? 0) + (latest.affiliate_revenue ?? 0),
      revenue_total: history.reduce((s: number, r: any) => s + (r.note_paid_sales ?? 0) + (r.affiliate_revenue ?? 0), 0) + (latest.membership_revenue ?? 0)
    } : null
  })
})

// ============================================================
// QAチェック(Mio)— 実動デモ
// ============================================================

app.post('/api/qa/check', async (c) => {
  const { text, has_affiliate } = await c.req.json<{ text: string; has_affiliate?: boolean }>()
  if (!text) return c.json({ error: 'text is required' }, 400)
  const result = runQaCheck(text, has_affiliate ?? false)
  return c.json(result)
})

app.get('/api/qa/rules', (c) => c.json(FORBIDDEN_RULES))

// ============================================================
// アフィリエイトリンク管理 + 自動埋め込み
// ============================================================

// 登録済みリンク一覧(③: クリック数付き)
app.get('/api/affiliate/links', async (c) => {
  const { DB } = c.env
  const rows = await DB.prepare(
    `SELECT l.*,
       (SELECT COUNT(*) FROM affiliate_clicks c WHERE c.link_id = l.link_id) AS clicks_total,
       (SELECT COUNT(*) FROM affiliate_clicks c WHERE c.link_id = l.link_id AND c.clicked_at > datetime('now', '-7 days')) AS clicks_7d
     FROM affiliate_links l ORDER BY l.created_at DESC`
  ).all().catch(async () => DB.prepare('SELECT * FROM affiliate_links ORDER BY created_at DESC').all())
  return c.json({ links: rows.results })
})

// リンク登録(取締役がASP提携後に1回だけ)
app.post('/api/affiliate/links', async (c) => {
  const { DB } = c.env
  const { tool_name, aliases, affiliate_url, program, note } = await c.req.json()
  if (!tool_name || !affiliate_url) return c.json({ error: 'tool_name と affiliate_url は必須です' }, 400)
  const id = 'af-' + Date.now().toString(36)
  const aliasJson = JSON.stringify(Array.isArray(aliases) && aliases.length ? aliases : [tool_name])
  await DB.prepare('INSERT INTO affiliate_links (link_id, tool_name, aliases, affiliate_url, program, note) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, tool_name, aliasJson, affiliate_url, program ?? null, note ?? null).run()
  return c.json({ ok: true, link_id: id })
})

// リンクの有効/停止切替・削除
app.post('/api/affiliate/links/:id/toggle', async (c) => {
  const { DB } = c.env
  await c.env.DB.prepare("UPDATE affiliate_links SET status = CASE status WHEN 'active' THEN 'paused' ELSE 'active' END WHERE link_id = ?")
    .bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

app.post('/api/affiliate/links/:id/delete', async (c) => {
  await c.env.DB.prepare('DELETE FROM affiliate_links WHERE link_id = ?').bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

// 自動埋め込みプレビュー(テキスト → 埋め込み後テキスト)
app.post('/api/affiliate/embed', async (c) => {
  const { DB } = c.env
  const { text } = await c.req.json<{ text: string }>()
  if (!text) return c.json({ error: 'text is required' }, 400)
  const links = (await DB.prepare('SELECT * FROM affiliate_links').all()).results as unknown as AffiliateLink[]
  const result = embedAffiliateLinks(text, links, await resolveClickBase(DB))
  return c.json(result)
})

// 指定投稿にアフィリンクを自動埋め込み(承認画面から実行)
app.post('/api/posts/:id/embed-affiliate', async (c) => {
  const { DB } = c.env
  const id = c.req.param('id')
  const post = await DB.prepare('SELECT * FROM x_posts WHERE post_id = ?').bind(id).first<any>()
  if (!post) return c.notFound()
  const links = (await DB.prepare('SELECT * FROM affiliate_links').all()).results as unknown as AffiliateLink[]
  const result = embedAffiliateLinks(post.body, links, await resolveClickBase(DB))
  if (!result.changed) return c.json({ ok: false, message: '埋め込み対象のツール名が見つかりませんでした', result })
  // 埋め込み後に再QA(PR表記が付くので needs_fix が解消されるケースあり)
  const qa = runQaCheck(result.embedded, true)
  await DB.prepare('UPDATE x_posts SET body = ?, qa_status = ?, qa_issues = ? WHERE post_id = ?')
    .bind(result.embedded, qa.status, JSON.stringify(qa.issues), id).run()
  return c.json({ ok: true, result, qa })
})

// ③ クリック計測リダイレクト(公開エンドポイント — 読者がアフィリンクを踏む入口)
// /go/:link_id → affiliate_clicks に記録 → 本来のアフィURLへ302
app.get('/go/:link_id', async (c) => {
  const { DB } = c.env
  const linkId = c.req.param('link_id')
  const link = await DB.prepare('SELECT affiliate_url FROM affiliate_links WHERE link_id = ?')
    .bind(linkId).first<{ affiliate_url: string }>()
  if (!link?.affiliate_url) return c.text('Not Found', 404)
  // 記録失敗でもリダイレクトは必ず行う(読者体験優先)
  try {
    await DB.prepare('INSERT INTO affiliate_clicks (link_id, referer, user_agent) VALUES (?, ?, ?)')
      .bind(linkId, c.req.header('Referer') || null, (c.req.header('User-Agent') || '').slice(0, 300) || null)
      .run()
  } catch { /* 計測テーブル未整備でも導線は生かす */ }
  return c.redirect(link.affiliate_url, 302)
})

// 用語注釈サジェスト(素人向け注釈チェック)
app.post('/api/glossary/suggest', async (c) => {
  const { DB } = c.env
  const { text } = await c.req.json<{ text: string }>()
  if (!text) return c.json({ error: 'text is required' }, 400)
  const glossary = (await DB.prepare('SELECT * FROM glossary').all()).results as unknown as GlossaryEntry[]
  return c.json({ suggestions: suggestAnnotations(text, glossary) })
})

app.get('/api/glossary', async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM glossary ORDER BY term').all()
  return c.json({ glossary: rows.results })
})

// ============================================================
// 全自動パイプライン: Riko→Kai→Yuto→Mio→ゲート②
// ============================================================

// 手動パイプライン実行(UIボタンから。認証ミドルウェアで保護済み)
app.post('/api/pipeline/run', async (c) => {
  const result = await runDailyPipeline(c.env.DB, c.env.R2, c.env.OPENAI_API_KEY || '', c.env as any)
  return c.json(result, result.ok ? 200 : 502)
})

// ── 手動トリガ: メンション回収→返信下書き生成(通常はJST 8/12/18/22時の自動実行) ──
app.post('/api/replies/collect', async (c) => {
  const { DB } = c.env
  const result = await collectMentionsAndDraft(DB, String(c.env.OPENAI_API_KEY || ''), c.env as any)
  if (!result.skippedNoCreds && (result.fetched > 0 || result.errors.length > 0)) {
    await DB.prepare(
      "INSERT INTO worker_logs (worker_name, action, status, output_json, finished_at) VALUES ('sora', 'mention_collect_manual', ?, ?, CURRENT_TIMESTAMP)",
    ).bind(result.ok ? 'success' : 'failed', JSON.stringify({ fetched: result.fetched, drafted: result.drafted, costUsd: result.costUsd, errors: result.errors.slice(0, 3) })).run()
  }
  return c.json(result, result.ok ? 200 : 502)
})

// ── 手動トリガ: 承認済み返信を今すぐ送信(通常は毎時の自動実行) ──
app.post('/api/replies/publish', async (c) => {
  const result = await publishApprovedReplies(c.env.DB, c.env as any)
  return c.json(result, result.ok ? 200 : 502)
})

// ── 手動トリガ: 予約時刻到来分の承認済み投稿を今すぐXに送信(通常は毎時の自動実行) ──
app.post('/api/sora/publish-due', async (c) => {
  const result = await runSoraScheduledPublish(c.env.DB, c.env.R2, c.env as any)
  return c.json(result, result.ok ? 200 : 502)
})

// ── 手動トリガ: セルフRT(インプ上位の自分の投稿をRT。1日1回ガードあり。通常はJST 21時の自動実行) ──
app.post('/api/selfrepost/run', async (c) => {
  const { DB } = c.env
  const result = await runSelfRepost(DB, c.env as any)
  if (!result.skippedNoCreds) {
    await DB.prepare(
      "INSERT INTO worker_logs (worker_name, action, status, output_json, finished_at) VALUES ('sora', 'self_repost_manual', ?, ?, CURRENT_TIMESTAMP)",
    ).bind(result.ok ? 'success' : 'failed', JSON.stringify({ reposted: result.reposted, postId: result.postId, impressions: result.impressions, error: result.error })).run()
  }
  return c.json(result, result.ok ? 200 : 502)
})

// Riko巡回のみ手動実行(ネタ収集だけしたいとき用)
app.post('/api/riko/crawl', async (c) => {
  const { DB } = c.env
  const started = Date.now()
  const result = await runRikoCrawl(DB, c.env.OPENAI_API_KEY || '')
  await DB.prepare(
    "INSERT INTO worker_logs (worker_name, action, status, output_json, finished_at) VALUES ('riko', 'manual_crawl', ?, ?, CURRENT_TIMESTAMP)"
  ).bind(
    result.ok ? 'success' : 'failed',
    JSON.stringify({ collected: result.collected, inserted: result.inserted, costUsd: result.costUsd, ms: Date.now() - started, error: result.error })
  ).run()
  return c.json(result, result.ok ? 200 : 502)
})

// Cron状態確認
app.get('/api/cron/status', async (c) => {
  const { DB } = c.env
  const logs = await DB.prepare(
    "SELECT worker_name, action, status, output_json, finished_at FROM worker_logs WHERE action IN ('auto_crawl', 'auto_translate', 'auto_write', 'auto_qa', 'manual_crawl', 'pipeline_run', 'weekly_plan', 'auto_infographic', 'image_plan', 'note_diagrams', 'auto_note', 'daily_analysis', 'weekly_analysis', 'monthly_analysis', 'daily_report', 'quote_crawl', 'auto_publish', 'kpi_collect', 'competitor_research', 'monthly_note', 'note_cover', 'mention_collect', 'reply_publish', 'slot_optimize', 'post_recycle', 'self_repost') ORDER BY id DESC LIMIT 22"
  ).all()
  return c.json({
    secretConfigured: !!c.env.CRON_SECRET,
    slotTable: SLOT_TABLE,
    recentRuns: logs.results,
  })
})

// Cron実行エンドポイント(GitHub Actionsから朝1回呼び出し)
// セッション認証の代わりに CRON_SECRET で認証する
app.post('/api/cron/run', async (c) => {
  const secret = c.env.CRON_SECRET
  if (!secret) return c.json({ error: 'CRON_SECRET が未設定です' }, 503)
  const auth = c.req.header('Authorization') || ''
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (provided !== secret) return c.json({ error: 'unauthorized' }, 401)

  // 毎時tick: JST5時台はフルパイプライン、それ以外は時刻到来分の自動投稿のみ
  const result = await runHourlyTick(c.env.DB, c.env.R2, c.env as any)
  return c.json(result)
})

// ============================================================
// Nana(秘書): 日次レポート / Rui(分析): 分析レポート / Alex(PM): 週次計画
// ============================================================

// 最新のNana日次レポート(ダッシュボード表示用)
app.get('/api/reports/daily', async (c) => {
  const { DB } = c.env
  const rows = await DB.prepare('SELECT * FROM daily_reports ORDER BY created_at DESC LIMIT 7').all()
  return c.json({ reports: rows.results })
})

// Rui分析レポート(日次+週次)
app.get('/api/reports/analysis', async (c) => {
  const { DB } = c.env
  const daily = await DB.prepare("SELECT * FROM analysis_reports WHERE report_type = 'daily' ORDER BY created_at DESC LIMIT 3").all()
  const weekly = await DB.prepare("SELECT * FROM analysis_reports WHERE report_type = 'weekly' ORDER BY created_at DESC LIMIT 2").all()
  const monthly = await DB.prepare("SELECT * FROM analysis_reports WHERE report_type = 'monthly' ORDER BY created_at DESC LIMIT 2").all()
  const competitor = await DB.prepare("SELECT * FROM analysis_reports WHERE report_type = 'competitor' ORDER BY created_at DESC LIMIT 1").all()
  return c.json({ daily: daily.results, weekly: weekly.results, monthly: monthly.results, competitor: competitor.results })
})

// Alex週次計画
app.get('/api/plans/weekly', async (c) => {
  const { DB } = c.env
  const rows = await DB.prepare('SELECT * FROM weekly_plans ORDER BY week_start DESC LIMIT 4').all()
  return c.json({ plans: rows.results })
})

// Nanaレポートを手動再生成(デバッグ/即時確認用)
app.post('/api/reports/daily/run', async (c) => {
  const result = await runNanaReport(c.env.DB, c.env.OPENAI_API_KEY || '')
  return c.json(result, result.ok ? 200 : 502)
})

// 引用RT候補のプレビュー(今日の話題ツイート収集を即時実行)
app.get('/api/quote/candidates', async (c) => {
  const { collectJaHotTweets } = await import('./sources')
  const result = await collectJaHotTweets(6)
  return c.json(result)
})

// Rui日次分析を手動実行(デバッグ/即時確認用)
app.post('/api/reports/analysis/run', async (c) => {
  const { runRuiDaily } = await import('./rui')
  const result = await runRuiDaily(c.env.DB, c.env.OPENAI_API_KEY || '')
  return c.json(result, result.ok ? 200 : 502)
})

// ============================================================
// フロントエンド(SPA)
// ============================================================

app.get('/', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Virtual Office | Mさん / 海外AI副業の検証部屋</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: { brand: { navy: '#1E3A5F', orange: '#FF7A45' } }
        }
      }
    }
  </script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <link href="/static/style.css" rel="stylesheet">
  <link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
</head>
<body class="bg-slate-100 text-slate-800">
  <header id="app-header" class="bg-brand-navy text-white shadow-lg sticky top-0 z-40">
    <div class="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between flex-wrap gap-2">
      <div class="flex items-center gap-3">
        <span class="text-2xl">🏢</span>
        <div>
          <h1 class="font-bold text-lg leading-tight">AI Virtual Office</h1>
          <p class="text-xs text-slate-300">Mさん / 海外AI副業の検証部屋</p>
        </div>
      </div>
      <nav id="main-nav" class="flex gap-1 text-sm flex-wrap">
        <button data-view="office" class="nav-btn px-3 py-2 rounded-lg hover:bg-white/10"><i class="fas fa-building mr-1"></i>オフィス</button>
        <button data-view="approve" class="nav-btn px-3 py-2 rounded-lg hover:bg-white/10"><i class="fas fa-check-double mr-1"></i>承認<span id="approval-badge" class="hidden ml-1 bg-brand-orange text-white text-xs px-1.5 py-0.5 rounded-full"></span></button>
        <button data-view="kpi" class="nav-btn px-3 py-2 rounded-lg hover:bg-white/10"><i class="fas fa-chart-line mr-1"></i>KPI</button>
        <button data-view="qa" class="nav-btn px-3 py-2 rounded-lg hover:bg-white/10"><i class="fas fa-shield-halved mr-1"></i>QAチェック</button>
        <button data-view="affiliate" class="nav-btn px-3 py-2 rounded-lg hover:bg-white/10"><i class="fas fa-link mr-1"></i>アフィリンク</button>
        <button data-view="images" class="nav-btn px-3 py-2 rounded-lg hover:bg-white/10"><i class="fas fa-image mr-1"></i>画像</button>
        <button data-view="cost" class="nav-btn px-3 py-2 rounded-lg hover:bg-white/10"><i class="fas fa-microchip mr-1"></i>AIコスト</button>
      </nav>
    </div>
  </header>

  <main id="app" class="max-w-7xl mx-auto px-4 py-6"></main>

  <footer class="text-center text-xs text-slate-400 py-6">
    取締役の承認3ゲート以外は9人のAIワーカーが自走します(現在はデモモード)
  </footer>

  <div id="modal-root"></div>
  <div id="toast-root" class="fixed bottom-4 right-4 z-50 space-y-2"></div>

  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
  <script src="/static/app.js"></script>
</body>
</html>`)
})

export default app
