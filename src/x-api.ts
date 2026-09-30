// X (Twitter) API v2 直接接続
// OAuth 1.0a User Context 署名を Web Crypto API (HMAC-SHA1) で実装 — Workers完全対応
//
// 必要なシークレット (X Developer Portal で取得):
//   X_API_KEY             (Consumer Key)
//   X_API_SECRET          (Consumer Secret)
//   X_ACCESS_TOKEN        (Access Token — 投稿するアカウントのもの)
//   X_ACCESS_TOKEN_SECRET (Access Token Secret)

export interface XCredentials {
  apiKey: string
  apiSecret: string
  accessToken: string
  accessTokenSecret: string
}

export function getXCredentials(env: Record<string, string | undefined>): XCredentials | null {
  const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET } = env
  if (!X_API_KEY || !X_API_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_TOKEN_SECRET) return null
  return {
    apiKey: X_API_KEY,
    apiSecret: X_API_SECRET,
    accessToken: X_ACCESS_TOKEN,
    accessTokenSecret: X_ACCESS_TOKEN_SECRET,
  }
}

function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

async function hmacSha1(key: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message))
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
}

async function buildOAuthHeader(
  creds: XCredentials,
  method: string,
  url: string,
  extraParams: Record<string, string> = {},
): Promise<string> {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ''),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.accessToken,
    oauth_version: '1.0',
  }
  // 署名ベース文字列 (JSONボディはOAuth1.0a署名に含めない)
  const allParams = { ...oauthParams, ...extraParams }
  const paramString = Object.keys(allParams).sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(allParams[k])}`).join('&')
  const baseString = [method.toUpperCase(), percentEncode(url), percentEncode(paramString)].join('&')
  const signingKey = `${percentEncode(creds.apiSecret)}&${percentEncode(creds.accessTokenSecret)}`
  const signature = await hmacSha1(signingKey, baseString)

  const header = { ...oauthParams, oauth_signature: signature }
  return 'OAuth ' + Object.keys(header).sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(header[k])}"`).join(', ')
}

export interface XPostResult {
  ok: boolean
  tweetId?: string
  tweetUrl?: string
  error?: string
}

// X の文字数カウント (weighted): CJK等は2、半角/絵文字近似は1〜2、URLは一律23
// 上限は weighted 280 (=日本語140字相当)
export function xWeightedLength(text: string): number {
  // URLは t.co 短縮で一律23文字換算
  const urlRe = /https?:\/\/[^\s]+/g
  let weight = 0
  const withoutUrls = text.replace(urlRe, () => {
    weight += 23
    return ''
  })
  for (const ch of withoutUrls) {
    const cp = ch.codePointAt(0) || 0
    // Twitter公式のweighted rangesの近似: ASCII/ラテン/一部記号=1、それ以外(CJK・かな・絵文字等)=2
    if (
      (cp >= 0x0000 && cp <= 0x10ff) ||
      (cp >= 0x2000 && cp <= 0x200d) ||
      (cp >= 0x2010 && cp <= 0x201f) ||
      (cp >= 0x2032 && cp <= 0x2037)
    ) {
      weight += 1
    } else {
      weight += 2
    }
  }
  return weight
}

export const X_WEIGHT_LIMIT = 280

// X Premium(有料プラン)加入済み: 1投稿あたり最大25,000文字まで投稿可能
// 通常投稿は長文1本で完結させる(ツリー/スレッド分割は廃止)
// リプライは従来どおり280 weighted(短文で十分なため)
export const X_PREMIUM_CHAR_LIMIT = 25000

// 一時的エラー判定(共通): 一時的なら次回リトライに残す、恒久ならrejected化する
// - 日本語/英語両方のネットワークエラーメッセージに対応(Workers実環境のfetch例外は英語)
// - HTTPステータス系は単語境界で判定(文中の数値への誤マッチ防止)
export function isTransientXError(error: string | undefined): boolean {
  const err = error || ''
  return /rate limit|too many requests|service unavailable|timeout|timed out|network|fetch failed|connection|aborted|socket|ECONNRESET|ETIMEDOUT|internal server error|ネットワークエラー|\b429\b|\b50[0-9]\b/i.test(err)
}

/**
 * 長文をスレッド用に分割する。
 * - 「1/」「2/」「1/n」等の番号付き行(Yutoのスレッド形式)があればそこで分割
 * - なければ空行(段落)→ 文(。!?改行)の順で、weighted 280以内に詰める
 */
export function splitForThread(text: string): string[] {
  const trimmed = text.trim()
  if (xWeightedLength(trimmed) <= X_WEIGHT_LIMIT) return [trimmed]

  // 番号付きスレッド形式: 行頭の「1/」「2/」「1/7」等で分割
  const numbered = trimmed.split(/\n(?=\s*\d{1,2}\/(?:\d{1,2})?\s*)/).map((s) => s.trim()).filter(Boolean)
  if (numbered.length >= 2 && numbered.every((s) => xWeightedLength(s) <= X_WEIGHT_LIMIT)) {
    return numbered
  }

  // 段落 → 文 の順に詰める
  const sentences: string[] = []
  for (const para of trimmed.split(/\n{2,}/)) {
    // 段落ごと入るならそのまま候補に
    if (xWeightedLength(para) <= X_WEIGHT_LIMIT) {
      sentences.push(para.trim())
    } else {
      // 文単位に分解 (。!?改行 の直後で切る)
      for (const s of para.split(/(?<=[。!?！？\n])/)) {
        if (s.trim()) sentences.push(s.trim())
      }
    }
  }

  const chunks: string[] = []
  let current = ''
  for (const s of sentences) {
    const candidate = current ? `${current}\n${s}` : s
    if (xWeightedLength(candidate) <= X_WEIGHT_LIMIT - 8) {
      // -8 は後付けする「(n/m)」の余白
      current = candidate
    } else {
      if (current) chunks.push(current)
      // 1文単体でも超える場合は強制切断
      if (xWeightedLength(s) > X_WEIGHT_LIMIT - 8) {
        let buf = ''
        for (const ch of s) {
          if (xWeightedLength(buf + ch) > X_WEIGHT_LIMIT - 8) {
            chunks.push(buf)
            buf = ch
          } else {
            buf += ch
          }
        }
        current = buf
      } else {
        current = s
      }
    }
  }
  if (current) chunks.push(current)
  return chunks
}

// テキスト投稿 (画像付きは事前にuploadMediaでmedia_id取得 / quoteTweetIdで引用RT / replyToIdでスレッド連結)
export async function postTweet(creds: XCredentials, text: string, mediaIds?: string[], quoteTweetId?: string, replyToId?: string): Promise<XPostResult> {
  const url = 'https://api.twitter.com/2/tweets'
  try {
    const auth = await buildOAuthHeader(creds, 'POST', url)
    const body: any = { text }
    if (mediaIds?.length) body.media = { media_ids: mediaIds }
    if (quoteTweetId) body.quote_tweet_id = quoteTweetId
    if (replyToId) body.reply = { in_reply_to_tweet_id: replyToId }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data: any = await res.json()
    if (!res.ok) {
      const detail = data?.detail || data?.errors?.[0]?.message || data?.title || `HTTP ${res.status}`
      return { ok: false, error: detail }
    }
    const tweetId = data.data?.id
    return { ok: true, tweetId, tweetUrl: tweetId ? `https://x.com/i/web/status/${tweetId}` : undefined }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'ネットワークエラー' }
  }
}

// ④ セルフリポスト: 自分のツイートをRT(POST /2/users/:id/retweets)
// コスト: Post Create扱いではなくWrite系 — Pay-Per-Use では安価なWriteアクション
export async function retweet(creds: XCredentials, userId: string, tweetId: string): Promise<{ ok: boolean; error?: string }> {
  const url = `https://api.twitter.com/2/users/${userId}/retweets`
  try {
    const auth = await buildOAuthHeader(creds, 'POST', url)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tweet_id: tweetId }),
    })
    const data: any = await res.json()
    if (!res.ok) {
      const detail = data?.detail || data?.errors?.[0]?.message || data?.title || `HTTP ${res.status}`
      return { ok: false, error: detail }
    }
    // 200でも retweeted=false の場合があるため error を返して無音失敗を防ぐ
    const retweeted = !!data.data?.retweeted
    return { ok: retweeted, error: retweeted ? undefined : 'APIは200を返しましたが retweeted=false でした(既にRT済みの可能性)' }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'ネットワークエラー' }
  }
}

export interface XThreadResult {
  ok: boolean
  tweetIds: string[]      // 投稿できた全ツイートID(先頭が親)
  tweetUrl?: string       // 先頭ツイートURL
  posted: number          // 投稿成功数
  total: number           // 分割総数
  error?: string
}

// スレッド投稿: 長文を自動分割し、リプライ連結で連投する
// - 画像は先頭ツイートのみに添付
// - 途中失敗したらそこで中断し、投稿済み分のIDを返す(先頭が成功していればok=true)
// - コスト: Post Create $0.015/件 × 分割数
export async function postThread(
  creds: XCredentials,
  text: string,
  mediaIds?: string[],
): Promise<XThreadResult> {
  const parts = splitForThread(text)
  const total = parts.length
  const tweetIds: string[] = []

  for (let i = 0; i < parts.length; i++) {
    // 2件以上に分割された場合、本文に番号がなければ「(n/m)」を付与
    let body = parts[i]
    if (total > 1 && !/^\s*\d{1,2}\//.test(body)) body = `${body}\n(${i + 1}/${total})`
    const replyTo = tweetIds.length ? tweetIds[tweetIds.length - 1] : undefined
    const r = await postTweet(creds, body, i === 0 ? mediaIds : undefined, undefined, replyTo)
    if (!r.ok || !r.tweetId) {
      return {
        ok: tweetIds.length > 0,
        tweetIds,
        tweetUrl: tweetIds[0] ? `https://x.com/i/web/status/${tweetIds[0]}` : undefined,
        posted: tweetIds.length,
        total,
        error: `${i + 1}本目で失敗: ${r.error}`,
      }
    }
    tweetIds.push(r.tweetId)
    if (i < parts.length - 1) await new Promise((res) => setTimeout(res, 1200)) // 連投のレート配慮
  }

  return {
    ok: true,
    tweetIds,
    tweetUrl: `https://x.com/i/web/status/${tweetIds[0]}`,
    posted: tweetIds.length,
    total,
  }
}

// 画像アップロード (v1.1 media/upload — v2投稿と併用可)
export async function uploadMedia(creds: XCredentials, imageB64: string): Promise<{ ok: boolean; mediaId?: string; error?: string }> {
  const url = 'https://upload.twitter.com/1.1/media/upload.json'
  try {
    // media_data はボディパラメータとして署名に含める (form-encoded)
    const auth = await buildOAuthHeader(creds, 'POST', url, { media_data: imageB64 })
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `media_data=${percentEncode(imageB64)}`,
    })
    const data: any = await res.json()
    if (!res.ok) return { ok: false, error: data?.errors?.[0]?.message || `HTTP ${res.status}` }
    return { ok: true, mediaId: data.media_id_string }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'ネットワークエラー' }
  }
}

// 自分のアカウント情報取得 (GET /2/users/me — 従量課金: User Read $0.010/回)
export async function fetchMyProfile(creds: XCredentials): Promise<{ ok: boolean; userId?: string; followers?: number; username?: string; error?: string }> {
  const url = 'https://api.twitter.com/2/users/me'
  try {
    const auth = await buildOAuthHeader(creds, 'GET', url, { 'user.fields': 'public_metrics' })
    const res = await fetch(`${url}?user.fields=public_metrics`, {
      headers: { 'Authorization': auth },
    })
    const data: any = await res.json()
    if (!res.ok) {
      return { ok: false, error: data?.detail || data?.title || `HTTP ${res.status}` }
    }
    return {
      ok: true,
      userId: data.data?.id,
      followers: data.data?.public_metrics?.followers_count ?? 0,
      username: data.data?.username,
    }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'ネットワークエラー' }
  }
}

// 自分の直近投稿のインプレッション/エンゲージメント合計
// (GET /2/users/{id}/tweets — Owned Read $0.001/件の特別価格、20件で$0.02/日。同一リソースは24h重複排除)
export interface TweetMetric {
  tweetId: string
  impressions: number
  engagements: number
}

export async function fetchMyTweetsMetrics(
  creds: XCredentials,
  userId: string,
): Promise<{ ok: boolean; impressions?: number; engagements?: number; tweetCount?: number; perTweet?: TweetMetric[]; error?: string }> {
  const url = `https://api.twitter.com/2/users/${userId}/tweets`
  // max_results=50: 直近4日分(12本/日×4日弱)をカバー。Owned Read $0.001/件=約$0.05/回
  const params: Record<string, string> = { max_results: '50', 'tweet.fields': 'public_metrics' }
  try {
    const auth = await buildOAuthHeader(creds, 'GET', url, params)
    const qs = Object.keys(params).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&')
    const res = await fetch(`${url}?${qs}`, { headers: { 'Authorization': auth } })
    const data: any = await res.json()
    if (!res.ok) {
      return { ok: false, error: data?.detail || data?.title || `HTTP ${res.status}` }
    }
    const tweets: any[] = Array.isArray(data.data) ? data.data : []
    let impressions = 0
    let engagements = 0
    const perTweet: TweetMetric[] = []
    for (const t of tweets) {
      const m = t?.public_metrics || {}
      const imp = m.impression_count || 0
      const eng = (m.like_count || 0) + (m.retweet_count || 0) + (m.reply_count || 0) + (m.quote_count || 0)
      impressions += imp
      engagements += eng
      if (t.id) perTweet.push({ tweetId: String(t.id), impressions: imp, engagements: eng })
    }
    return { ok: true, impressions, engagements, tweetCount: tweets.length, perTweet }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'ネットワークエラー' }
  }
}

// 自分宛てメンションの取得
// (GET /2/users/{id}/mentions — Owned Read $0.001/リソース。since_idで差分取得し重複課金を回避)
export interface XMention {
  tweetId: string
  authorId: string
  authorUsername: string
  text: string
  createdAt: string
}

export async function fetchMyMentions(
  creds: XCredentials,
  userId: string,
  sinceId?: string,
): Promise<{ ok: boolean; mentions?: XMention[]; newestId?: string; error?: string }> {
  const url = `https://api.twitter.com/2/users/${userId}/mentions`
  const params: Record<string, string> = {
    max_results: '20',
    'tweet.fields': 'author_id,created_at',
    expansions: 'author_id',
    'user.fields': 'username',
  }
  if (sinceId) params.since_id = sinceId
  try {
    const auth = await buildOAuthHeader(creds, 'GET', url, params)
    const qs = Object.keys(params).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&')
    const res = await fetch(`${url}?${qs}`, { headers: { 'Authorization': auth } })
    const data: any = await res.json()
    if (!res.ok) {
      return { ok: false, error: data?.detail || data?.title || `HTTP ${res.status}` }
    }
    const users: Record<string, string> = {}
    for (const u of data.includes?.users || []) {
      if (u?.id) users[u.id] = u.username || ''
    }
    const mentions: XMention[] = []
    for (const t of (Array.isArray(data.data) ? data.data : [])) {
      if (!t?.id) continue
      mentions.push({
        tweetId: String(t.id),
        authorId: String(t.author_id || ''),
        authorUsername: users[t.author_id] || '',
        text: String(t.text || ''),
        createdAt: String(t.created_at || ''),
      })
    }
    return { ok: true, mentions, newestId: data.meta?.newest_id ? String(data.meta.newest_id) : undefined }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'ネットワークエラー' }
  }
}
