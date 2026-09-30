// Nana: KPI自動収集(毎朝パイプライン内で実行)
// 自動で取れるもの:
//   ① Xフォロワー数 (X API /2/users/me — User Read $0.010/回)
//   ② Xインプレッション/エンゲージメント (X API /2/users/{id}/tweets — Owned Read $0.001/件)
//   ③ noteフォロワー数・記事スキ数 (note公開API — 認証不要)
//   ④ note閲覧数PV (note非公式API /api/v1/stats/pv — sessionクッキー必要)
//   ⑤ メンバーシップ会員数 (note非公式API /api/v2/circle/members — sessionクッキー必要)
// 手動入力が必要なもの: note売上件数・金額、アフィ収益(API非存在のためダッシュボードから入力)
//
// note sessionクッキー(_note_session_v5)は app_settings に保存。
// 失効を検知したら note_session_status='expired' にしてダッシュボードに通知バナーを表示する。
import { getXCredentials, fetchMyProfile, fetchMyTweetsMetrics } from './x-api'

export interface KpiCollectResult {
  ok: boolean
  xFollowers?: number
  xImpressions?: number
  xEngagements?: number
  noteFollowers?: number
  noteLikesTotal?: number
  noteViewsTotal?: number
  membershipCount?: number
  noteSessionStatus?: 'ok' | 'expired' | 'unset'
  sources: string[]
  errors: string[]
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

// ============ app_settings ヘルパー ============
export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row: any = await db.prepare('SELECT value FROM app_settings WHERE key = ?').bind(key).first()
  return row?.value || null
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(key, value, value)
    .run()
}

export async function getNoteUsername(db: D1Database): Promise<string | null> {
  return getSetting(db, 'note_username')
}

// ============ note公開API(認証不要) ============
async function fetchNoteCreator(urlname: string): Promise<{ followers?: number; error?: string }> {
  try {
    const res = await fetch(`https://note.com/api/v2/creators/${encodeURIComponent(urlname)}`, {
      headers: { 'User-Agent': UA },
    })
    if (!res.ok) return { error: `note API HTTP ${res.status}` }
    const data: any = await res.json()
    const followers = data?.data?.followerCount
    return typeof followers === 'number' ? { followers } : { error: 'note APIレスポンス形式不明' }
  } catch (e: any) {
    return { error: e?.message || 'note API接続エラー' }
  }
}

async function fetchNoteLikes(urlname: string): Promise<{ likes?: number; error?: string }> {
  try {
    const res = await fetch(`https://note.com/api/v2/creators/${encodeURIComponent(urlname)}/contents?kind=note&page=1`, {
      headers: { 'User-Agent': UA },
    })
    if (!res.ok) return { error: `note contents API HTTP ${res.status}` }
    const data: any = await res.json()
    const contents = data?.data?.contents
    if (!Array.isArray(contents)) return { error: 'note contents形式不明' }
    const likes = contents.reduce((s: number, c: any) => s + (c?.likeCount || 0), 0)
    return { likes }
  } catch (e: any) {
    return { error: e?.message || 'note contents接続エラー' }
  }
}

// ============ note非公式API(sessionクッキー必要) ============
function noteAuthHeaders(sessionCookie: string): Record<string, string> {
  return { 'User-Agent': UA, Cookie: `_note_session_v5=${sessionCookie}` }
}

// セッション有効性チェック(current_userが取れれば有効)
export async function checkNoteSession(sessionCookie: string): Promise<{ valid: boolean; nickname?: string; error?: string }> {
  try {
    const res = await fetch('https://note.com/api/v2/current_user', { headers: noteAuthHeaders(sessionCookie) })
    if (res.status === 401 || res.status === 403) return { valid: false, error: `認証エラー HTTP ${res.status}` }
    if (!res.ok) return { valid: false, error: `HTTP ${res.status}` }
    const data: any = await res.json()
    const nickname = data?.data?.nickname || data?.data?.urlname
    // ログインしていないとdataが空/idなしで返るケースがあるためidの有無で判定
    if (data?.data?.id) return { valid: true, nickname }
    return { valid: false, error: 'セッション無効(ユーザー情報が取得できません)' }
  } catch (e: any) {
    return { valid: false, error: e?.message || 'note接続エラー' }
  }
}

// 記事別PV統計 → 合計PV(全ページ巡回、上限5ページで安全弁)
async function fetchNotePvTotal(sessionCookie: string): Promise<{ views?: number; error?: string; expired?: boolean }> {
  try {
    let total = 0
    for (let page = 1; page <= 5; page++) {
      const res = await fetch(`https://note.com/api/v1/stats/pv?filter=all&page=${page}&sort=pv`, {
        headers: noteAuthHeaders(sessionCookie),
      })
      if (res.status === 401 || res.status === 403) return { expired: true, error: 'セッション失効' }
      if (!res.ok) return { error: `stats API HTTP ${res.status}` }
      const data: any = await res.json()
      const stats = data?.data?.note_stats || data?.data?.stats || data?.data?.contents
      if (!Array.isArray(stats) || stats.length === 0) {
        // 1ページ目から空 = セッション切れの可能性(noteは未ログインで空を返すことがある)
        if (page === 1 && !data?.data) return { expired: true, error: 'セッション失効の可能性(データ空)' }
        break
      }
      for (const s of stats) total += s?.read_count ?? s?.pv ?? 0
      const last = data?.data?.last_page === true || stats.length < 10
      if (last) break
      await new Promise((r) => setTimeout(r, 400)) // 低頻度アクセスを厳守
    }
    return { views: total }
  } catch (e: any) {
    return { error: e?.message || 'stats接続エラー' }
  }
}

// メンバーシップ会員数
async function fetchMembershipCount(sessionCookie: string): Promise<{ count?: number; error?: string; expired?: boolean }> {
  try {
    const res = await fetch('https://note.com/api/v2/circle/members', { headers: noteAuthHeaders(sessionCookie) })
    if (res.status === 401 || res.status === 403) return { expired: true, error: 'セッション失効' }
    if (res.status === 404) return { count: 0 } // メンバーシップ未開設
    if (!res.ok) return { error: `circle API HTTP ${res.status}` }
    const data: any = await res.json()
    const members = data?.data?.members ?? data?.data?.memberships ?? data?.data
    if (Array.isArray(members)) return { count: members.length }
    if (typeof data?.data?.totalCount === 'number') return { count: data.data.totalCount }
    return { count: 0 }
  } catch (e: any) {
    return { error: e?.message || 'circle接続エラー' }
  }
}

// ============ メイン: 自動収集 → kpi_daily UPSERT ============
export async function collectKpiAuto(db: D1Database, env: Record<string, string | undefined>): Promise<KpiCollectResult> {
  const result: KpiCollectResult = { ok: false, sources: [], errors: [] }
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10) // JST

  // ① Xフォロワー数 + ② インプレッション/エンゲージメント
  const creds = getXCredentials(env)
  if (creds) {
    const prof = await fetchMyProfile(creds)
    if (prof.ok) {
      result.xFollowers = prof.followers
      result.sources.push(`X API(@${prof.username})`)
      if (prof.userId) {
        const metrics = await fetchMyTweetsMetrics(creds, prof.userId)
        if (metrics.ok) {
          result.xImpressions = metrics.impressions
          result.xEngagements = metrics.engagements
          result.sources.push(`Xインプレ(直近${metrics.tweetCount}投稿)`)

          // 投稿別メトリクスをx_postsへ書き戻し(buffer_id=tweet_idで突合)
          // → Ruiの枠別分析・売上TOP共通点分析が実データで回るようになる
          let written = 0
          for (const t of metrics.perTweet || []) {
            try {
              const r = await db
                .prepare('UPDATE x_posts SET impressions = ?, engagements = ? WHERE buffer_id = ?')
                .bind(t.impressions, t.engagements, t.tweetId)
                .run()
              if (r.meta?.changes) written++
            } catch { /* 個別失敗は無視して続行 */ }
          }
          if (written > 0) result.sources.push(`投稿別実績${written}本を更新`)
        } else {
          result.errors.push(`Xインプレ取得失敗: ${metrics.error}`)
        }
      }
    } else {
      result.errors.push(`Xフォロワー取得失敗: ${prof.error}`)
    }
  } else {
    result.errors.push('X APIキー未設定のためX指標は取得スキップ')
  }

  // ③ noteフォロワー数・スキ数(公開API)
  const noteUser = await getNoteUsername(db)
  if (noteUser) {
    const creator = await fetchNoteCreator(noteUser)
    if (creator.followers !== undefined) {
      result.noteFollowers = creator.followers
      result.sources.push(`note API(${noteUser})`)
    } else if (creator.error) {
      result.errors.push(`noteフォロワー取得失敗: ${creator.error}`)
    }
    const likes = await fetchNoteLikes(noteUser)
    if (likes.likes !== undefined) result.noteLikesTotal = likes.likes
  } else {
    result.errors.push('noteユーザー名未設定(設定画面から登録するとnote指標を自動取得します)')
  }

  // ④ note PV + ⑤ メンバー数(sessionクッキー必要)
  const sessionCookie = await getSetting(db, 'note_session_v5')
  if (sessionCookie) {
    let expired = false
    const pv = await fetchNotePvTotal(sessionCookie)
    if (pv.views !== undefined) {
      result.noteViewsTotal = pv.views
      result.sources.push('note PV(stats API)')
    } else {
      if (pv.expired) expired = true
      result.errors.push(`note PV取得失敗: ${pv.error}`)
    }
    if (!expired) {
      const mem = await fetchMembershipCount(sessionCookie)
      if (mem.count !== undefined) {
        result.membershipCount = mem.count
        result.sources.push('noteメンバー数(circle API)')
      } else {
        if (mem.expired) expired = true
        if (mem.error) result.errors.push(`メンバー数取得失敗: ${mem.error}`)
      }
    }
    // 失効フラグを保存(ダッシュボード通知用)
    result.noteSessionStatus = expired ? 'expired' : 'ok'
    await setSetting(db, 'note_session_status', result.noteSessionStatus)
    await setSetting(db, 'note_session_checked_at', new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' '))
    if (expired) result.errors.push('⚠️ note sessionクッキーが失効しています。設定画面から再登録してください')
  } else {
    result.noteSessionStatus = 'unset'
  }

  // kpi_daily にUPSERT(自動取得できた列のみ更新。手動列は保持)
  const hasAny =
    result.xFollowers !== undefined || result.noteFollowers !== undefined ||
    result.xImpressions !== undefined || result.noteViewsTotal !== undefined || result.membershipCount !== undefined
  if (hasAny) {
    await db
      .prepare(
        `INSERT INTO kpi_daily (date, x_followers, x_impressions_total, x_engagements_total, note_followers, note_views_total, membership_count)
         VALUES (?, COALESCE(?, 0), COALESCE(?, 0), COALESCE(?, 0), COALESCE(?, 0), COALESCE(?, 0), COALESCE(?, 0))
         ON CONFLICT(date) DO UPDATE SET
           x_followers = COALESCE(?, x_followers),
           x_impressions_total = COALESCE(?, x_impressions_total),
           x_engagements_total = COALESCE(?, x_engagements_total),
           note_followers = COALESCE(?, note_followers),
           note_views_total = COALESCE(?, note_views_total),
           membership_count = COALESCE(?, membership_count)`,
      )
      .bind(
        today,
        result.xFollowers ?? null, result.xImpressions ?? null, result.xEngagements ?? null,
        result.noteFollowers ?? null, result.noteViewsTotal ?? null, result.membershipCount ?? null,
        result.xFollowers ?? null, result.xImpressions ?? null, result.xEngagements ?? null,
        result.noteFollowers ?? null, result.noteViewsTotal ?? null, result.membershipCount ?? null,
      )
      .run()
  }

  result.ok = result.sources.length > 0
  return result
}
