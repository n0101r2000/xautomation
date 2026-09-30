// OpenAI モデル代替プラン & コスト試算
// 旧設計: Anthropic Claude Sonnet(高品質) + Haiku(軽量) 併用
// 新設計: OpenAI gpt-5 / gpt-5-mini / gpt-5-nano の3段構え

export type ModelId = 'gpt-5' | 'gpt-5-mini' | 'gpt-5-nano'

// 料金 (USD / 100万トークン) ※2026-08 時点の公開価格
export const MODEL_PRICING: Record<ModelId, { input: number; output: number; label: string; tier: string }> = {
  'gpt-5':      { input: 1.25, output: 10.0, label: 'GPT-5',      tier: '高品質 (旧: Claude Sonnet 相当)' },
  'gpt-5-mini': { input: 0.25, output: 2.0,  label: 'GPT-5 mini', tier: '中量級 (旧: Sonnet/Haiku 中間)' },
  'gpt-5-nano': { input: 0.05, output: 0.4,  label: 'GPT-5 nano', tier: '軽量 (旧: Claude Haiku 相当)' },
}

export const USD_JPY = 150 // 想定レート

export interface WorkerModelPlan {
  workerId: string
  name: string
  role: string
  icon: string
  model: ModelId
  oldModel: string          // 旧設計 (Claude)
  reason: string            // このモデルを選ぶ理由
  dailyTasks: string        // 1日のタスク内容
  dailyCalls: number        // 1日の呼び出し回数
  inputTokensPerCall: number
  outputTokensPerCall: number
}

export const WORKER_MODEL_PLANS: WorkerModelPlan[] = [
  {
    workerId: 'alex', name: 'Alex', role: 'PM/進行管理', icon: '🧑‍💼',
    model: 'gpt-5', oldModel: 'Claude Haiku',
    reason: '週の方向性を決める要。テーマ分解・タスク配分は高度な判断が必要なため最上位+推論high(週次1回)',
    dailyTasks: '週次テーマ分解・曜日別タスク配分 (月曜1回/週)',
    dailyCalls: 1, inputTokensPerCall: 4000, outputTokensPerCall: 4000,
  },
  {
    workerId: 'riko', name: 'Riko', role: '企画/リサーチ', icon: '🔍',
    model: 'gpt-5', oldModel: 'Claude Sonnet',
    reason: 'ネタ選定の質が全工程の起点。品質優先方針でgpt-5+推論mediumに格上げ',
    dailyTasks: '海外AI情報の実クロール(RSS/Reddit) → ネタ候補10本の選定・スコアリング (1回/日)',
    dailyCalls: 1, inputTokensPerCall: 8000, outputTokensPerCall: 4000,
  },
  {
    workerId: 'kai', name: 'Kai', role: '翻訳/ローカライズ', icon: '🌐',
    model: 'gpt-5', oldModel: 'Claude Sonnet',
    reason: '翻訳の正確性が信頼の生命線。品質優先方針でgpt-5+推論mediumに格上げ',
    dailyTasks: '上位4ネタの原文取得(Reddit/HTML)+英日翻訳・事実/解釈分離 (4本)',
    dailyCalls: 4, inputTokensPerCall: 4000, outputTokensPerCall: 2500,
  },
  {
    workerId: 'yuto', name: 'Yuto', role: 'ライター', icon: '✍️',
    model: 'gpt-5', oldModel: 'Claude Sonnet',
    reason: 'X投稿12本+note記事は収益の生命線。noteは推論highで3000字超の長文品質を最大化',
    dailyTasks: 'X投稿12本の執筆 + note記事1本/日(週無料6・有料1) + QAリライト',
    dailyCalls: 15, inputTokensPerCall: 4000, outputTokensPerCall: 2500,
  },
  {
    workerId: 'aki', name: 'Aki', role: '画像/クリエイティブ', icon: '🎨',
    model: 'gpt-5', oldModel: 'Claude Haiku',
    reason: '枠3図解の視覚化ポイント抽出。図解設計の質が画像の質を決める',
    dailyTasks: '枠3図解の設計(1回/日) ※画像生成 gpt-image-2 約$0.04/枚 + Mio画像QAは別途',
    dailyCalls: 1, inputTokensPerCall: 1500, outputTokensPerCall: 500,
  },
  {
    workerId: 'sora', name: 'Sora', role: 'SNS運用', icon: '📱',
    model: 'gpt-5-nano', oldModel: 'Claude Haiku',
    reason: '投稿スケジューリング・ハッシュタグ調整は定型作業',
    dailyTasks: '12本の投稿時間最適化・ハッシュタグ付与・リプライ下書き',
    dailyCalls: 20, inputTokensPerCall: 900, outputTokensPerCall: 300,
  },
  {
    workerId: 'nana', name: 'Nana', role: '秘書/報告', icon: '📋',
    model: 'gpt-5-mini', oldModel: 'Claude Haiku',
    reason: '日次レポートは事実集約の定型処理。miniで十分な要約品質',
    dailyTasks: '日次レポート(300字)作成 + 24h滞留リマインド検知 (1回/日)',
    dailyCalls: 1, inputTokensPerCall: 2000, outputTokensPerCall: 800,
  },
  {
    workerId: 'rui', name: 'Rui', role: '分析/KPI', icon: '📊',
    model: 'gpt-5', oldModel: 'Claude Sonnet',
    reason: '分析の質が改善サイクルの起点。品質優先方針でgpt-5+推論mediumに格上げ',
    dailyTasks: '日次仮説分析 (1回/日) + 日曜の週次7日総括・改善提案3つ',
    dailyCalls: 1.2, inputTokensPerCall: 6000, outputTokensPerCall: 3000,
  },
  {
    workerId: 'mio', name: 'Mio', role: 'QA/法務チェック', icon: '🛡️',
    model: 'gpt-5-mini', oldModel: 'Claude Sonnet',
    reason: '薬機法・景表法チェックは見逃しリスクが高い。キーワードエンジン+LLM二重チェックでmini採用',
    dailyTasks: '全投稿・note記事の禁止表現チェック (12本+リライト再チェック)',
    dailyCalls: 18, inputTokensPerCall: 2000, outputTokensPerCall: 500,
  },
]

export interface WorkerCostRow extends WorkerModelPlan {
  dailyInputTokens: number
  dailyOutputTokens: number
  dailyCostUsd: number
  monthlyCostUsd: number
  monthlyCostJpy: number
}

export function computeCostPlan() {
  const rows: WorkerCostRow[] = WORKER_MODEL_PLANS.map((p) => {
    const price = MODEL_PRICING[p.model]
    const dailyInputTokens = p.dailyCalls * p.inputTokensPerCall
    const dailyOutputTokens = p.dailyCalls * p.outputTokensPerCall
    const dailyCostUsd =
      (dailyInputTokens / 1_000_000) * price.input +
      (dailyOutputTokens / 1_000_000) * price.output
    const monthlyCostUsd = dailyCostUsd * 30
    return {
      ...p,
      dailyInputTokens,
      dailyOutputTokens,
      dailyCostUsd,
      monthlyCostUsd,
      monthlyCostJpy: monthlyCostUsd * USD_JPY,
    }
  })

  const totalDailyUsd = rows.reduce((s, r) => s + r.dailyCostUsd, 0)
  const totalMonthlyUsd = totalDailyUsd * 30

  // モデル別集計
  const byModel: Record<string, { model: ModelId; workers: string[]; monthlyCostUsd: number }> = {}
  for (const r of rows) {
    if (!byModel[r.model]) byModel[r.model] = { model: r.model, workers: [], monthlyCostUsd: 0 }
    byModel[r.model].workers.push(r.name)
    byModel[r.model].monthlyCostUsd += r.monthlyCostUsd
  }

  return {
    usdJpy: USD_JPY,
    pricing: MODEL_PRICING,
    rows,
    byModel: Object.values(byModel),
    totals: {
      dailyUsd: totalDailyUsd,
      monthlyUsd: totalMonthlyUsd,
      monthlyJpy: totalMonthlyUsd * USD_JPY,
      // 参考: 旧Claude構成の概算 (Sonnet $3/$15, Haiku $0.8/$4 per 1M)
      oldClaudeMonthlyUsd: computeOldClaudeCost(),
    },
    notes: [
      'OpenAI APIキーで運用可能。Anthropic不要 (base_urlをOpenAI互換エンドポイントに設定)',
      '料金は2026年8月時点の公開価格 (USD/100万トークン)。為替は1ドル=150円で換算',
      'トークン数は運用想定に基づく概算。実運用でプロンプトキャッシュを使えばさらに30〜50%削減可能',
      '画像生成 (Aki用) は別途 gpt-image-1 等の従量課金が必要 (1枚 $0.01〜0.17程度)',
      'X API (投稿自動化) / note投稿は別費用・別権限。本試算はLLMテキスト生成のみ',
    ],
  }
}

function computeOldClaudeCost(): number {
  // 旧設計: Sonnet($3 in / $15 out), Haiku($0.8 in / $4 out)
  const sonnet = { input: 3.0, output: 15.0 }
  const haiku = { input: 0.8, output: 4.0 }
  let total = 0
  for (const p of WORKER_MODEL_PLANS) {
    const wasSonnet = p.oldModel.includes('Sonnet')
    const price = wasSonnet ? sonnet : haiku
    const daily =
      ((p.dailyCalls * p.inputTokensPerCall) / 1_000_000) * price.input +
      ((p.dailyCalls * p.outputTokensPerCall) / 1_000_000) * price.output
    total += daily * 30
  }
  return total
}
