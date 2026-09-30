// P1-5 投稿時間最適化 (Rui)
// P0-3で書き戻される投稿別実績(x_posts.impressions)を使い、
// 枠ごとのベスト投稿時間帯を週次(月曜)で再計算して SLOT_TABLE を動的化する。
// - デフォルト時刻から±2時間の範囲内でのみ調整(枠のコンセプト=時間帯依存を壊さない)
// - 同一時間帯に3投稿以上の実績がある場合のみ採用(少データでの過学習防止)
// - 結果は app_settings('slot_time_overrides') にJSON保存し、パイプラインが参照

export interface SlotOptimizeResult {
  ok: boolean
  analyzed: number                          // 分析対象の投稿数
  overrides: Record<number, string>         // slot -> "HH:MM"
  changes: string[]                         // 人間可読の変更内容
  error?: string
}

const OVERRIDE_KEY = 'slot_time_overrides'

// 保存済みオーバーライドを読み込み (なければ空)
export async function loadSlotOverrides(db: D1Database): Promise<Record<number, string>> {
  try {
    const row: any = await db.prepare('SELECT value FROM app_settings WHERE key = ?').bind(OVERRIDE_KEY).first()
    if (row?.value) {
      const parsed = JSON.parse(row.value)
      if (parsed && typeof parsed === 'object') return parsed
    }
  } catch { /* 未設定 */ }
  return {}
}

// 週次再計算: 直近60日の公開済み投稿の 枠×時間帯(JST) 平均インプレッションから最適時刻を算出
export async function runSlotOptimize(
  db: D1Database,
  defaults: { slot: number; time: string }[],
): Promise<SlotOptimizeResult> {
  const result: SlotOptimizeResult = { ok: true, analyzed: 0, overrides: {}, changes: [] }
  try {
    // 枠×時間帯ごとの実績 (JST時間、インプレッションが記録されたもののみ)
    const rows = await db.prepare(
      `SELECT slot_number, CAST(strftime('%H', published_at, '+9 hours') AS INTEGER) AS jst_hour,
              COUNT(*) AS cnt, AVG(impressions) AS avg_imp
       FROM x_posts
       WHERE published_at IS NOT NULL AND impressions > 0
         AND published_at > datetime('now', '-60 days')
       GROUP BY slot_number, jst_hour`,
    ).all()
    const stats = (rows.results || []) as any[]
    result.analyzed = stats.reduce((s, r) => s + (r.cnt || 0), 0)
    if (stats.length === 0) {
      // 実績なし: オーバーライドを設定しない (デフォルト時刻のまま)
      return result
    }

    const prev = await loadSlotOverrides(db)
    const overrides: Record<number, string> = {}

    for (const def of defaults) {
      const [defH, defM] = def.time.split(':').map(Number)
      // デフォルト±2時間の範囲で、3投稿以上の実績がある時間帯のみ候補にする
      const candidates = stats.filter((s) =>
        s.slot_number === def.slot && s.cnt >= 3 && Math.abs(s.jst_hour - defH) <= 2)
      if (candidates.length === 0) continue
      candidates.sort((a, b) => (b.avg_imp || 0) - (a.avg_imp || 0))
      const best = candidates[0]
      // デフォルト時間帯より10%以上良い場合のみ変更 (誤差での揺れ防止)
      const defStat = candidates.find((c) => c.jst_hour === defH)
      if (best.jst_hour !== defH && (!defStat || (best.avg_imp || 0) > (defStat.avg_imp || 0) * 1.1)) {
        const newTime = `${String(best.jst_hour).padStart(2, '0')}:${String(defM).padStart(2, '0')}`
        overrides[def.slot] = newTime
        if (prev[def.slot] !== newTime) {
          result.changes.push(`枠${def.slot}: ${prev[def.slot] || def.time} → ${newTime} (平均${Math.round(best.avg_imp)}imp/${best.cnt}投稿)`)
        }
      }
    }

    result.overrides = overrides
    await db.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
      .bind(OVERRIDE_KEY, JSON.stringify(overrides)).run()
  } catch (e: any) {
    result.ok = false
    result.error = e?.message || 'slot最適化エラー'
  }
  return result
}
