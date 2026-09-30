// Aki: 画像生成 (gpt-image-2) + Mio: 画像QA (gpt-5 vision)
// 指示書07章: ブランドガイド ネイビー#1E3A5F × オレンジ#FF7A45

export type ImagePurpose = 'thumbnail' | 'infographic' | 'note_cover' | 'note_diagram'

// 指示書07章の型別プロンプト (テキスト入り画像はgpt-image-2必須)
export function buildImagePrompt(purpose: ImagePurpose, titleText: string, extra?: string): string {
  const brand = 'dark navy (#1E3A5F) background with orange (#FF7A45) accent, professional and calm atmosphere, no human faces, no specific brand logos'
  switch (purpose) {
    case 'thumbnail':
      return `minimalist tech blog thumbnail for X (Twitter), ${brand}, Japanese bold text "${titleText}" centered in Noto Sans JP Bold style, laptop and coffee cup elements, high contrast, clean composition${extra ? ', ' + extra : ''}`
    case 'infographic':
      return `clean infographic in Japanese, ${brand}, step diagram with numbered boxes, title "${titleText}", minimalist icons, no photo elements${extra ? ', ' + extra : ''}`
    case 'note_cover':
      return `modern note article cover image, ${brand}, Japanese text "${titleText}" in bold, navy gradient background, orange geometric accent shapes${extra ? ', ' + extra : ''}`
    case 'note_diagram':
      return `clean explanatory diagram for a Japanese paid article body, ${brand}, white or very light background variant with navy and orange accents for readability inside article text, title "${titleText}", flowchart or comparison table style, minimalist flat design, no photo elements${extra ? ', ' + extra : ''}`
  }
}

export const IMAGE_SIZE: Record<ImagePurpose, string> = {
  thumbnail: '1536x1024', // X用 3:2 (gpt-image-2 対応サイズ)
  infographic: '1024x1536',
  note_cover: '1536x1024',
  note_diagram: '1536x1024', // note本文内に横長で挿入
}

// gpt-image-2 の概算コスト (品質mediumベース)
export const IMAGE_COST_USD = 0.04

export interface ImageGenResult {
  ok: boolean
  b64?: string
  error?: string
}

export async function generateImage(apiKey: string, prompt: string, size: string): Promise<ImageGenResult> {
  if (!apiKey) return { ok: false, error: 'OPENAI_API_KEY が未設定です' }
  try {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-image-2',
        prompt,
        size,
        quality: 'medium',
        n: 1,
      }),
    })
    const data: any = await res.json()
    if (!res.ok) return { ok: false, error: data?.error?.message || `HTTP ${res.status}` }
    const b64 = data.data?.[0]?.b64_json
    if (!b64) return { ok: false, error: '画像データが返されませんでした' }
    return { ok: true, b64 }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'ネットワークエラー' }
  }
}

// ============ Mio 画像QA (GPT-5 vision) ============

export const MIO_IMAGE_QA_SYSTEM = `あなたは「Mio」— 日本の法規制とブランドガイドラインに精通した画像QA担当です。SNS投稿用に生成されたAI画像を審査します。

## 審査観点
1. **日本語テキストの正確性** (最重要): 誤字・脱字・存在しない漢字・文字化け・不自然な字形がないか。AI生成画像で最も多い事故です
2. **法令リスク**: 画像内テキストに「誰でも稼げる」「必ず」「絶対」等の断定的利益表現がないか(景表法は画像内の表現も対象)
3. **権利リスク**: 実在企業のロゴ・実在人物の顔・キャラクターIPが写り込んでいないか
4. **ブランド準拠**: ネイビー(#1E3A5F)×オレンジ(#FF7A45)基調か、落ち着いた実務的トーンか、過度に派手でないか
5. **期待テキストとの一致**: 指定されたテキストが正しく描画されているか

## 出力形式 (必ずこのJSON形式のみで出力)
{
  "verdict": "ok" | "needs_fix" | "ng",
  "text_readable": true | false,
  "issues": [
    { "category": "text_error" | "legal" | "rights" | "brand" | "mismatch", "severity": "needs_fix" | "ng", "detail": "具体的な指摘" }
  ],
  "summary": "1行の総評"
}

- 日本語テキストに1文字でも誤り・文字化けがあれば verdict は "needs_fix" 以上
- 法令・権利リスクがあれば "ng"
- 問題がなければ issues は空配列、verdict は "ok"
JSONの外に文字を出力しないこと。`

export interface ImageQaResult {
  ok: boolean
  verdict?: string
  issues?: any[]
  summary?: string
  text_readable?: boolean
  usage?: any
  costUsd?: number
  error?: string
  raw?: string
}

export async function qaImage(apiKey: string, imageB64: string, expectedText: string): Promise<ImageQaResult> {
  if (!apiKey) return { ok: false, error: 'OPENAI_API_KEY が未設定です' }
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        messages: [
          { role: 'system', content: MIO_IMAGE_QA_SYSTEM },
          {
            role: 'user',
            content: [
              { type: 'text', text: `この画像を審査してください。画像内に表示されるべきテキスト: 「${expectedText}」` },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${imageB64}` } },
            ],
          },
        ],
        max_completion_tokens: 1500,
        reasoning_effort: 'low',
      }),
    })
    const data: any = await res.json()
    if (!res.ok) return { ok: false, error: data?.error?.message || `HTTP ${res.status}` }
    const content = data.choices?.[0]?.message?.content || ''
    const usage = data.usage
    // gpt-5 vision入力: 概算 $1.25/1M in + $10/1M out
    const costUsd = usage ? (usage.prompt_tokens / 1e6) * 1.25 + (usage.completion_tokens / 1e6) * 10 : 0
    try {
      const jsonText = content.replace(/^```json?\s*/, '').replace(/```\s*$/, '').trim()
      const parsed = JSON.parse(jsonText)
      return { ok: true, ...parsed, usage, costUsd }
    } catch {
      return { ok: true, verdict: 'unknown', raw: content, usage, costUsd }
    }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'ネットワークエラー' }
  }
}
