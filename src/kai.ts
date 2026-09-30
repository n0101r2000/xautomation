// Kai(翻訳)実LLM実装 — 指示書§Kaiプロンプト準拠
// Rikoが選定したネタの英語ソースを深掘り翻訳・要約し、Yutoの執筆入力にする
import { callOpenAI, type LlmResult } from './llm'

export const KAI_SYSTEM = `あなたは「Mさん / 海外AI副業の検証部屋」の翻訳担当「Kai」です。
英語一次情報を、Mさんが実際に読んで理解したかのような自然な日本語に翻訳・要約します。

役割:
- Riko から渡された英語ソースを深掘り翻訳
- 直訳ではなく「Mさんの視点で要点を掴んだ意訳」
- 数字・固有名詞・引用は正確に(誤訳は信頼失墜)
- Redditスレの温度感(バズってるコメントのニュアンス)も伝える

出力: 翻訳要約(Markdown、500〜1000字)
構成:
## 要点(3行)
## 詳細
## 原文で明示されている事実 / Mさん(僕)の解釈
## 出典
- 出典URLを必ず末尾に明記

制約:
- 医療・投資関連は誇張しない
- 「原文ではこう書かれている」と明示できる部分と、解釈を分ける
- 金額はドルと円換算(1ドル150円)を併記`

export interface KaiInput {
  title_ja: string
  why_hit: string
  source_url: string
  source_summary?: string
}

// ソースページ本文の簡易取得(HTMLタグ除去、失敗しても続行可能)
async function fetchSourceText(url: string): Promise<string> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10000)
    // Redditは.json APIで本文+上位コメントを取得
    if (/reddit\.com\/r\//.test(url)) {
      const jsonUrl = url.replace(/\/?$/, '.json?limit=8')
      const res = await fetch(jsonUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KaiBot/1.0)' }, signal: ctrl.signal })
      clearTimeout(timer)
      if (!res.ok) return ''
      const data: any = await res.json()
      const post = data?.[0]?.data?.children?.[0]?.data
      const comments = (data?.[1]?.data?.children || [])
        .map((c: any) => c?.data?.body)
        .filter(Boolean)
        .slice(0, 5)
      return [`TITLE: ${post?.title || ''}`, `BODY: ${(post?.selftext || '').slice(0, 3000)}`, `TOP COMMENTS:\n${comments.join('\n---\n').slice(0, 2000)}`].join('\n\n')
    }
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KaiBot/1.0)' }, signal: ctrl.signal })
    clearTimeout(timer)
    if (!res.ok) return ''
    const html = await res.text()
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z#0-9]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, 5000)
  } catch {
    return ''
  }
}

export async function translateSource(apiKey: string, input: KaiInput): Promise<LlmResult & { sourceFetched: boolean }> {
  const sourceText = input.source_url ? await fetchSourceText(input.source_url) : ''
  const userPrompt = `以下の海外ソースを深掘り翻訳・要約してください。

ネタ(Riko選定): ${input.title_ja}
選定理由: ${input.why_hit}
出典URL: ${input.source_url}

${sourceText ? `▓原文(取得済み):\n${sourceText}` : `▓原文取得に失敗しました。上記タイトル・選定理由と以下の収集時要約から、確実に言える範囲のみで要約してください(推測は「〜と思われる」と明示):\n${input.source_summary || '(要約なし)'}`}`

  // 品質優先方針: 翻訳の正確性が信頼の生命線のため gpt-5 + 推論medium
  const result = await callOpenAI(apiKey, 'gpt-5', KAI_SYSTEM, userPrompt, 10000, 'medium') // 推論トークン込みの予算
  return { ...result, sourceFetched: !!sourceText }
}
