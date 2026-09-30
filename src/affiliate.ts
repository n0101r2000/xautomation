// アフィリエイトリンク自動埋め込み + 用語注釈サジェスト
//
// 仕組み:
//  1. 取締役がASP提携後、リンクを1回だけ登録(/api/affiliate/links)
//  2. 以後、投稿文からツール名(エイリアス含む)を自動検出
//  3. 検出したら「リンク行 + PR表記」を自動で末尾に付与
//  ※ ASPの提携申請そのものは規約上・技術上の理由で人間の操作が必要

export interface AffiliateLink {
  link_id: string
  tool_name: string
  aliases: string // JSON配列
  affiliate_url: string
  program: string | null
  status: string
  auto_embed: number
}

export interface EmbedResult {
  original: string
  embedded: string
  detected: { tool_name: string; affiliate_url: string; matched: string }[]
  pr_added: boolean
  changed: boolean
}

/**
 * 投稿文からツール名を検出し、アフィリンク+PR表記を自動埋め込みする
 * @param clickBase 指定時はクリック計測用リダイレクトURL(`${clickBase}/go/${link_id}`)を埋め込む(③クリック計測)
 */
export function embedAffiliateLinks(text: string, links: AffiliateLink[], clickBase?: string): EmbedResult {
  const detected: EmbedResult['detected'] = []

  for (const link of links) {
    if (link.status !== 'active' || !link.auto_embed) continue
    let aliases: string[] = []
    try { aliases = JSON.parse(link.aliases) } catch { aliases = [link.tool_name] }
    const matched = aliases.find((a) => a && text.toLowerCase().includes(a.toLowerCase()))
    if (matched && !text.includes(link.affiliate_url)) {
      // クリック計測: clickBase指定時は /go/:link_id 経由URLに置き換え(302で本来のアフィURLへ)
      const url = clickBase ? `${clickBase.replace(/\/$/, '')}/go/${link.link_id}` : link.affiliate_url
      if (clickBase && text.includes(url)) continue // 計測URLが既に埋め込まれている場合も重複回避
      detected.push({ tool_name: link.tool_name, affiliate_url: url, matched })
    }
  }

  if (detected.length === 0) {
    return { original: text, embedded: text, detected: [], pr_added: false, changed: false }
  }

  // リンク行を生成
  const linkLines = detected.map((d) => `▼${d.tool_name}はこちら\n${d.affiliate_url}`).join('\n')

  // PR表記(既にあれば追加しない)
  const hasPr = text.includes('#PR') || text.includes('アフィリエイト')
  const prLine = hasPr ? '' : '\n#PR(アフィリエイトリンクを含みます)'

  const embedded = `${text}\n\n${linkLines}${prLine}`
  return { original: text, embedded, detected, pr_added: !hasPr, changed: true }
}

// クリック計測リダイレクトのベースURL解決
// app_settings 'app_base_url' があればそれを使用、なければ本番URL固定値
export const DEFAULT_APP_BASE_URL = 'https://0c9c4d00-0596-4d2b-8bc9-5a2b11a4709d.vip.gensparksite.com'

export async function resolveClickBase(db: D1Database): Promise<string> {
  try {
    const row = await db.prepare("SELECT value FROM app_settings WHERE key = 'app_base_url'").first<{ value: string }>()
    if (row?.value) return String(row.value).replace(/\/$/, '')
  } catch { /* app_settings未整備でもデフォルトで動く */ }
  return DEFAULT_APP_BASE_URL
}

export interface GlossaryEntry {
  term: string
  annotation: string
  category: string | null
}

/** 投稿文から辞書に載っている固有名詞を検出し、注釈サジェストを返す */
export function suggestAnnotations(text: string, glossary: GlossaryEntry[]): { term: string; annotation: string; already_annotated: boolean }[] {
  const results: { term: string; annotation: string; already_annotated: boolean }[] = []
  for (const g of glossary) {
    if (text.toLowerCase().includes(g.term.toLowerCase())) {
      // 「※Term=」形式の注釈が既にあるか
      const already = text.includes(`※${g.term}`) || text.includes(g.annotation.slice(0, 10))
      results.push({ term: g.term, annotation: g.annotation, already_annotated: already })
    }
  }
  return results
}
