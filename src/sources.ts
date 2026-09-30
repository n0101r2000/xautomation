// 情報ソース監視リスト(指示書§04準拠)
// YouTube Data API / X監視はAPIキーが必要なため後日追加(キー取得後に有効化)

export interface RedditSource {
  subreddit: string
  min_upvotes: number
  category: string
}

export interface RssSource {
  url: string
  name: string
}

export const SOURCES = {
  reddit: [
    // 海外AI副業系
    { subreddit: 'Entrepreneur', min_upvotes: 500, category: '海外AI副業' },
    { subreddit: 'SideHustle', min_upvotes: 300, category: '海外AI副業' },
    { subreddit: 'juststart', min_upvotes: 100, category: '海外AI副業' },
    { subreddit: 'passive_income', min_upvotes: 200, category: '海外AI副業' },
    { subreddit: 'KDP', min_upvotes: 100, category: '海外AI副業' },
    { subreddit: 'Etsy', min_upvotes: 200, category: '海外AI副業' },
    { subreddit: 'PrintOnDemand', min_upvotes: 100, category: '海外AI副業' },
    { subreddit: 'AI_Agents', min_upvotes: 100, category: 'AIツール' },
    { subreddit: 'ChatGPT', min_upvotes: 500, category: 'AIツール' },
    { subreddit: 'ClaudeAI', min_upvotes: 200, category: 'AIツール' },
    // Faceless動画系
    { subreddit: 'NewTubers', min_upvotes: 200, category: 'Faceless動画' },
    { subreddit: 'PartneredYoutube', min_upvotes: 100, category: 'Faceless動画' },
  ] as RedditSource[],

  rss: [
    { url: 'https://www.indiehackers.com/feed.xml', name: 'Indie Hackers' },
    { url: 'https://www.producthunt.com/feed', name: 'Product Hunt Daily' },
    { url: 'https://www.starterstory.com/blog.rss', name: 'Starter Story' },
    { url: 'https://hnrss.org/newest?q=side+hustle+OR+passive+income+OR+AI+business&points=50', name: 'Hacker News (副業関連)' },
  ] as RssSource[],

  // YouTube Data API キー取得後に有効化(指示書§04)
  youtube: { channel_ids: [] as string[], max_age_hours: 48 },
}

export interface RawItem {
  title: string
  url: string
  source: string
  score?: number
  summary?: string
  published?: string
}

// ---- RSS/Atom 軽量パーサ(Workers環境: DOMParserなし → 正規表現ベース) ----
function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '')
    .trim()
}

function extractTag(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return m ? decodeEntities(m[1]) : ''
}

export function parseFeed(xml: string, sourceName: string, maxItems = 10): RawItem[] {
  const items: RawItem[] = []
  // RSS 2.0 <item> / Atom <entry>
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || []
  for (const block of blocks.slice(0, maxItems)) {
    const title = extractTag(block, 'title')
    let url = extractTag(block, 'link')
    if (!url) {
      // Atom: <link href="..."/>
      const m = block.match(/<link[^>]*href="([^"]+)"/i)
      if (m) url = m[1]
    }
    const summary = (extractTag(block, 'description') || extractTag(block, 'summary') || extractTag(block, 'content')).slice(0, 300)
    const published = extractTag(block, 'pubDate') || extractTag(block, 'published') || extractTag(block, 'updated')
    if (title && url) items.push({ title, url, source: sourceName, summary, published })
  }
  return items
}

// ---- 収集 ----
const FETCH_TIMEOUT_MS = 10000

async function fetchWithTimeout(url: string, headers: Record<string, string> = {}): Promise<Response | null> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    const res = await fetch(url, { headers, signal: ctrl.signal })
    clearTimeout(timer)
    return res.ok ? res : null
  } catch {
    return null
  }
}

export async function collectRss(maxPerFeed = 8): Promise<{ items: RawItem[]; errors: string[] }> {
  const items: RawItem[] = []
  const errors: string[] = []
  const results = await Promise.allSettled(
    SOURCES.rss.map(async (feed) => {
      const res = await fetchWithTimeout(feed.url, { 'User-Agent': 'Mozilla/5.0 (compatible; RikoBot/1.0)' })
      if (!res) throw new Error(`fetch failed: ${feed.name}`)
      const xml = await res.text()
      return parseFeed(xml, feed.name, maxPerFeed)
    })
  )
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...r.value)
    else errors.push(`RSS ${SOURCES.rss[i].name}: ${r.reason?.message || 'error'}`)
  })
  return { items, errors }
}

export async function collectReddit(maxPerSub = 5): Promise<{ items: RawItem[]; errors: string[] }> {
  const items: RawItem[] = []
  const errors: string[] = []
  // 全subredditは重いので上位カテゴリからランダムに6つ選択(日替わりローテーション)
  const dayIndex = Math.floor(Date.now() / 86400000)
  const subs = [...SOURCES.reddit]
  const picked: RedditSource[] = []
  for (let i = 0; i < 6 && subs.length > 0; i++) {
    picked.push(subs.splice((dayIndex + i * 7) % subs.length, 1)[0])
  }
  const results = await Promise.allSettled(
    picked.map(async (src) => {
      // Reddit公開JSON API(認証不要)
      const url = `https://www.reddit.com/r/${src.subreddit}/top.json?t=day&limit=${maxPerSub * 2}`
      const res = await fetchWithTimeout(url, { 'User-Agent': 'Mozilla/5.0 (compatible; RikoBot/1.0; +https://example.com)' })
      if (!res) throw new Error(`fetch failed: r/${src.subreddit}`)
      const data: any = await res.json()
      const posts = (data?.data?.children || []) as any[]
      return posts
        .map((p) => p.data)
        .filter((d) => d && d.ups >= Math.min(src.min_upvotes, 50) && !d.stickied)
        .slice(0, maxPerSub)
        .map((d): RawItem => ({
          title: d.title,
          url: `https://www.reddit.com${d.permalink}`,
          source: `r/${src.subreddit}`,
          score: d.ups,
          summary: (d.selftext || '').slice(0, 300),
        }))
    })
  )
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...r.value)
    else errors.push(`Reddit r/${picked[i].subreddit}: ${r.reason?.message || 'error'}`)
  })
  return { items, errors }
}

// ============================================================
// 日本語の話題ツイート収集 (Yahoo!リアルタイム検索経由・無料)
// ============================================================

export interface JaHotTweet {
  tweetId: string
  url: string          // 引用元URL (utm除去済み)
  author: string       // 表示名
  screenName: string   // @なし
  text: string         // 本文
  rtCount: number
  replyCount: number
  score: number        // rt*2 + reply
  keyword: string      // ヒットした検索語
  createdAt: number    // unix秒
}

// 検索キーワード(日替わりで4語ローテーション)
export const JA_TWEET_KEYWORDS = [
  'AI副業',
  '生成AI 稼ぐ',
  'ChatGPT 活用術',
  'AIツール 便利',
  'note 収益化',
  'AI 自動化 仕事',
  'Claude 活用',
  'AI画像生成 副業',
]

function stripYahooMarkers(s: string): string {
  return s.replace(/\tSTART\t/g, '').replace(/\tEND\t/g, '').replace(/\t/g, ' ').trim()
}

// スパム・挨拶投稿の除外(引用価値のない投稿)
function isQuoteWorthy(t: JaHotTweet): boolean {
  const txt = t.text
  if (txt.length < 40) return false                          // 短すぎる
  if (/フォロバ|フォローありがとう|フォロー(お願い|して)/.test(txt)) return false
  if (/^@\w+/.test(txt)) return false                        // リプライ
  if (/(LINE|公式ライン|プレゼント配布|無料配布|DM(ください|で))/.test(txt) && /登録|追加|受け取/.test(txt)) return false // リスト誘導系
  if ((txt.match(/#/g) || []).length >= 5) return false      // ハッシュタグ乱打
  return true
}

// 1キーワード分の検索結果からツイートを抽出
export async function fetchYahooRealtime(keyword: string): Promise<JaHotTweet[]> {
  const url = `https://search.yahoo.co.jp/realtime/search?p=${encodeURIComponent(keyword)}&md=t`
  const res = await fetchWithTimeout(url, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    'Accept-Language': 'ja,en;q=0.8',
  })
  if (!res) throw new Error(`fetch failed: ${keyword}`)
  const html = await res.text()
  const m = html.match(/window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/)
    || html.match(/<script id="__NEXT_DATA__"[^>]*>(\{[\s\S]*?\})<\/script>/)
  if (!m) throw new Error(`state JSON not found: ${keyword}`)
  const state = JSON.parse(m[1])

  // ネスト内の entry 配列を探索
  const findEntries = (obj: any, depth = 0): any[] | null => {
    if (depth > 8 || obj === null || typeof obj !== 'object') return null
    if (Array.isArray(obj.entry) && obj.entry.length > 0 && obj.entry[0]?.id) return obj.entry
    for (const v of Object.values(obj)) {
      const r = findEntries(v, depth + 1)
      if (r) return r
    }
    return null
  }
  const entries = findEntries(state) || []
  return entries
    .filter((e: any) => e.id && e.displayText && e.screenName)
    .map((e: any): JaHotTweet => {
      const rt = Number(e.rtCount || 0)
      const rep = Number(e.replyCount || 0)
      return {
        tweetId: String(e.id),
        url: `https://x.com/${e.screenName}/status/${e.id}`,
        author: stripYahooMarkers(String(e.name || e.screenName)),
        screenName: String(e.screenName),
        text: stripYahooMarkers(String(e.displayText)),
        rtCount: rt,
        replyCount: rep,
        score: rt * 2 + rep,
        keyword,
        createdAt: Number(e.createdAt || 0),
      }
    })
}

// 引用RT候補を収集: 複数キーワード検索→フィルタ→スコア順
// minScore: 最低バズ度(rt*2+reply)。届かない場合は空を返し通常投稿にフォールバック
export async function collectJaHotTweets(minScore = 6): Promise<{ candidates: JaHotTweet[]; errors: string[] }> {
  const errors: string[] = []
  const all: JaHotTweet[] = []
  // 日替わりで4キーワード選択(全部叩くと重い+アクセス集中を避ける)
  const dayIndex = Math.floor(Date.now() / 86400000)
  const picked: string[] = []
  for (let i = 0; i < 4; i++) picked.push(JA_TWEET_KEYWORDS[(dayIndex + i * 3) % JA_TWEET_KEYWORDS.length])

  for (const kw of picked) {
    try {
      const tweets = await fetchYahooRealtime(kw)
      all.push(...tweets)
      await new Promise((r) => setTimeout(r, 800)) // アクセス間隔
    } catch (e: any) {
      errors.push(`Yahoo検索「${kw}」: ${e?.message || 'error'}`)
    }
  }

  // 24時間以内 + 引用価値フィルタ + 重複除去 + スコア順
  const dayAgo = Date.now() / 1000 - 86400
  const seen = new Set<string>()
  const candidates = all
    .filter((t) => t.createdAt > dayAgo && t.score >= minScore && isQuoteWorthy(t))
    .filter((t) => (seen.has(t.tweetId) ? false : (seen.add(t.tweetId), true)))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)

  return { candidates, errors }
}

// 投稿直前の生存確認 (X公式oEmbed・認証不要)
export async function verifyTweetAlive(tweetId: string, screenName: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(
      `https://publish.twitter.com/oembed?url=${encodeURIComponent(`https://twitter.com/${screenName}/status/${tweetId}`)}&omit_script=1`,
    )
    if (!res) return false
    const data: any = await res.json()
    return !!data?.html
  } catch {
    return false
  }
}
