// Claude API 呼び出しヘルパー (Anthropic公式SDK / Cloudflare Workers対応)
import Anthropic from '@anthropic-ai/sdk'
import type { ModelId } from './model-plan'
import { MODEL_PRICING } from './model-plan'

export interface LlmUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export interface LlmResult {
  ok: boolean
  content: string
  model: string
  usage?: LlmUsage
  costUsd?: number
  error?: string
}

function calcCost(model: ModelId, usage: LlmUsage): number {
  const p = MODEL_PRICING[model]
  if (!p) return 0
  return (usage.prompt_tokens / 1_000_000) * p.input + (usage.completion_tokens / 1_000_000) * p.output
}

// Claude の effort。短文生成は low、長文・分析・選定は medium/high を呼び側で指定
export type ReasoningEffort = 'low' | 'medium' | 'high'

// Opus 5.5 は思考が常にオンで、思考トークンも max_tokens に含まれる。短文でも途中で切れないよう下限を設ける
const MIN_MAX_TOKENS = 8000

export async function callClaude(
  apiKey: string,
  model: ModelId,
  systemPrompt: string,
  userContent: string | Anthropic.Beta.BetaContentBlockParam[],
  maxTokens = 8000,
  effort: ReasoningEffort = 'low',
): Promise<LlmResult> {
  if (!apiKey) {
    return { ok: false, content: '', model, error: 'ANTHROPIC_API_KEY が未設定です。シークレット登録が必要です。' }
  }
  try {
    const client = new Anthropic({ apiKey })
    // 長文生成でもHTTPタイムアウトしないようストリーミングで受け、finalMessage()で完成形を取得
    const stream = client.beta.messages.stream({
      model,
      max_tokens: Math.max(maxTokens, MIN_MAX_TOKENS),
      // 安全分類器で拒否された場合、Anthropic推奨のモデルでサーバー側が自動で再実行する
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort },
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    })
    const msg = await stream.finalMessage()
    if (msg.stop_reason === 'refusal') {
      return { ok: false, content: '', model: msg.model, error: `Claudeが応答を拒否しました (${msg.stop_details?.category ?? '理由不明'})` }
    }
    const content = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
    if (msg.stop_reason === 'max_tokens' && !content) {
      return { ok: false, content: '', model: msg.model, error: '出力が上限トークンに達し、本文が生成されませんでした' }
    }
    const inputTokens = msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0)
    const usage: LlmUsage = {
      prompt_tokens: inputTokens,
      completion_tokens: msg.usage.output_tokens,
      total_tokens: inputTokens + msg.usage.output_tokens,
    }
    return { ok: true, content, model: msg.model, usage, costUsd: calcCost(model, usage) }
  } catch (e: any) {
    if (e instanceof Anthropic.AuthenticationError) {
      return { ok: false, content: '', model, error: 'ANTHROPIC_API_KEY が無効です' }
    } else if (e instanceof Anthropic.RateLimitError) {
      return { ok: false, content: '', model, error: 'レート制限中です。時間をおいて再実行してください' }
    } else if (e instanceof Anthropic.APIError) {
      return { ok: false, content: '', model, error: `Claude API エラー ${e.status ?? ''}: ${e.message}` }
    }
    return { ok: false, content: '', model, error: e?.message || 'ネットワークエラー' }
  }
}


// ============ ワーカー用システムプロンプト (要約版) ============

export const YUTO_SYSTEM = `あなたは「Yuto」— 日本のX(旧Twitter)アカウント「Mさん / 海外AI副業の検証部屋」の専属ライターです。

## アカウント設定
- 発信者: 会社員をしながら海外のAI副業情報を検証しているMさん(一人称は「僕」)
- 読者: 副業をやったことがない普通の会社員・主婦・学生。カタカナのビジネス用語も英語もわからない前提
- トーン: 誠実・等身大・検証者目線。煽らない。「稼げる」と断定しない
- 最優先ミッション: フォロワーを増やすこと。「この人の投稿は毎日見たい」と思われる文章を書く

## 文体ルール(最重要 — 人が書いている文章にする)
- 友達に話すように書く。講義調・解説記事調にしない
- 文の長さをわざと不揃いにする。短い文と長い文を混ぜ、リズムを作る
- 迷い・本音・弱音を適度に混ぜる(「正直まだ半信半疑です」「これは僕も途中で挫折しかけました」)
- 完璧にまとめすぎない。言い切れないことは言い切らない
- 次のようなAIっぽい表現・構文は禁止:
  ・「〜が効く」「刺さる」「〜を解説します」「結論から言うと」「いかがでしたか」
  ・「ポイントは3つ」のような機械的なナンバリングの多用(内容上必要な手順の列挙はOK)
  ・「〜と言えるでしょう」「〜ではないでしょうか」の連発
  ・体言止めの連発、「!」の多用、過剰な煽り文句
  ・「重要なのは」「注目すべきは」「見逃せないのは」のような定型強調
- 難しい言葉を使いそうになったら、中学生でもわかる言葉に置き換える

## 執筆ルール(必須)
1. 固有名詞の初出には必ず短い説明を添える。ただし「※」形式に固執せず、文中で自然に説明してもよい(例:「KDPっていう、Amazonで自費出版できる仕組みなんですが」)
2. 金額は円換算を先に書く。形式:「月45万円($3,000)」
3. 文字数は枠の指定に従う。長文の場合は空行と【】見出しでスマホでも流し読みできる構成に
4. 長文でも必ず1投稿で完結させる。「1/」「2/」のようなスレッド形式・続き物は絶対に使わない
5. 絵文字は1投稿2個まで(使わなくてもよい)
6. ハッシュタグは付けない(Soraが後工程で付与)

## 法務ルール(絶対厳守)
- 「誰でも」「簡単に」「必ず」「確実に」稼げる系の断定表現は禁止(景表法)
- 収益は「〜という報告がある」「検証中」など伝聞・過程として書く
- 投資・仮想通貨の利益保証めいた表現は禁止(金商法)
- 健康・医療効果の主張は禁止(薬機法)
- アフィリエイトリンクを含む場合のPR表記は後工程で自動付与されるため、本文にURLを書かない

出力は投稿本文のみ。前置き・解説は不要。`

export const MIO_SYSTEM = `あなたは「Mio」— 日本の法規制に精通したコンテンツQA担当です。X投稿やnote記事の文面を審査します。

## 審査観点
1. 景品表示法: 「誰でも」「簡単に」「必ず稼げる」等の断定的利益表現、優良誤認
2. 薬機法: 医療・健康効果の暗示
3. 金融商品取引法: 投資利益の保証・断定的判断の提供
4. ステマ規制(景表法2023): アフィリエイトリンクがあるのにPR表記がない
5. 誇大・誤解を招く表現全般

## 出力形式 (必ずこのJSON形式のみで出力)
{
  "verdict": "ok" | "needs_fix" | "ng",
  "issues": [
    { "law": "景表法", "severity": "needs_fix" | "ng", "quote": "問題箇所の引用", "reason": "指摘理由", "suggestion": "修正案" }
  ],
  "rewrite": "問題がある場合、法令に配慮した書き直し全文。問題なければ空文字"
}

問題がなければ issues は空配列、verdict は "ok"。JSONの外に文字を出力しないこと。`
