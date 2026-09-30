// Yuto note記事自動執筆: 週7本(無料6・有料1)+月1本の月次まとめ
// 価格戦略(0→1優先): 有料単発¥100 / 月次まとめ¥500(メンバーシップは当面休止)
// 品質優先方針: noteは収益の柱のため gpt-5 + 推論high で長文品質を最大化
import { callOpenAI, type LlmResult } from './llm'
import { runQaCheck } from './qa-rules'

export const YUTO_NOTE_SYSTEM = `あなたは「Yuto」— 日本のnoteアカウント「Mさん / 海外AI副業の検証部屋」の専属ライターです。

## アカウント設定
- 発信者: 会社員をしながら海外のAI副業情報を検証しているMさん(一人称は「僕」)
- 読者: 副業をやったことがない普通の会社員・主婦・学生。カタカナのビジネス用語も英語もわからない前提
- トーン: 誠実・等身大・検証者目線。煽らない。「稼げる」と断定しない

## 文体ルール(最重要 — 人が書いている文章にする)
- 友達に話すように書く。講義調・解説記事調にしない
- 文の長さをわざと不揃いにする。短い文と長い文を混ぜてリズムを作る
- 迷い・本音・弱音を適度に混ぜる(「正直まだ半信半疑です」など)
- 次のようなAIっぽい表現・構文は禁止: 「〜が効く」「刺さる」「結論から言うと」「いかがでしたか」「〜と言えるでしょう」の連発、機械的なナンバリングの多用、体言止めの連発、「重要なのは」「注目すべきは」のような定型強調
- 難しい言葉を使いそうになったら、中学生でもわかる言葉に置き換える

## note執筆ルール(必須)
1. 固有名詞の初出には必ず短い説明を添える。文中で自然に説明してもよい(例:「KDPっていう、Amazonで自費出版できる仕組みなんですが」)
2. 金額は円換算を先に。形式:「月45万円($3,000)」
3. Markdown形式。見出し(##/###)、箇条書き、太字を活用して読みやすく
4. 冒頭に「この記事でわかること」を箇条書きで提示
5. 具体的な手順・数字・出典を含め、読者が今日から動ける内容にする
6. 文末に「僕の検証メモ」として一次情報への姿勢・注意点を添える

## 有料記事の場合の追加ルール(最重要)
- 無料部分だけでも読者に明確な価値がある構成にする(出し惜しみ感を出さない)
- 有料部分で完結する(具体手順・テンプレート・数字の深掘りは有料側)
- paywall(有料ライン)の直前に「ここから先で得られるもの」を1〜2行で明示

## 法務ルール(絶対厳守)
- 「誰でも」「簡単に」「必ず」「確実に」稼げる系の断定表現は禁止(景表法)
- 収益は「〜という報告がある」「検証中」など伝聞・過程として書く
- 投資・仮想通貨の利益保証めいた表現は禁止(金商法)
- 健康・医療効果の主張は禁止(薬機法)

出力は記事本文(Markdown)のみ。1行目は「# タイトル」。有料記事の場合、paywall位置に単独行で「<!--paywall-->」を挿入すること。`

export interface NoteWriterResult {
  ok: boolean
  articleId?: string
  title?: string
  type: 'free' | 'paid_single' | 'membership' | 'monthly_summary'
  qaStatus?: string
  costUsd: number
  error?: string
}

// JSTの曜日 (0=日曜)
function jstDay(): number {
  return new Date(Date.now() + 9 * 3600 * 1000).getUTCDay()
}

// 今日のnote種別: 日曜=有料単発(¥100)、それ以外=無料
// ※メンバーシップは当面休止(低価格noteのみで収益化する方針)。再開時はここに土曜分岐を戻す
export function todayNoteType(): 'free' | 'paid_single' | 'membership' {
  const d = jstDay()
  if (d === 0) return 'paid_single'
  return 'free'
}

// アフィリエイトリンクの自動埋め込み(activeのみ)。失敗しても本文は壊さない
async function autoEmbedAffiliate(db: D1Database, bodyMd: string): Promise<string> {
  try {
    const { embedAffiliateLinks, resolveClickBase } = await import('./affiliate')
    const rows = await db.prepare("SELECT * FROM affiliate_links WHERE status = 'active'").all()
    const links = (rows.results || []) as any[]
    if (!links.length) return bodyMd
    const clickBase = await resolveClickBase(db) // ③クリック計測URL経由で埋め込む
    const r = embedAffiliateLinks(bodyMd, links as any, clickBase)
    return r.embedded || bodyMd
  } catch {
    return bodyMd
  }
}

// note記事1本を執筆(パイプラインから日次で呼ばれる)
export async function runNoteWriter(
  db: D1Database,
  apiKey: string,
  topic: { topic_id: string; title_ja: string; why_hit?: string },
  kaiMarkdown: string,
): Promise<NoteWriterResult> {
  const type = todayNoteType()
  const result: NoteWriterResult = { ok: false, type, costUsd: 0 }
  try {
    // 用語集(注釈の一貫性)
    const gl = await db.prepare('SELECT term, annotation FROM glossary LIMIT 30').all()
    const glossaryNote = ((gl.results || []) as any[]).map((g) => `※${g.term}=${g.annotation}`).join('\n')

    // 直近のnoteタイトル(重複回避)
    const recent = await db
      .prepare(`SELECT title FROM note_articles WHERE created_at > datetime('now', '-14 days') ORDER BY created_at DESC LIMIT 14`)
      .all()
    const recentTitles = ((recent.results || []) as any[]).map((r) => `- ${r.title}`).join('\n') || '(なし)'

    const isPaid = type === 'paid_single'
    const isMembership = type === 'membership'
    const priceYen = isPaid ? 100 : 0 // メンバーシップは記事単価0(月額¥500で読み放題)
    const spec = isPaid
      ? `## 今回の依頼: 有料note記事(100円 — ワンコイン以下のお試し価格)
- 分量: 3000〜4500字
- 価格戦略: 100円は「気軽に買える検証レポート」。まず0→1の購入体験を作ることが目的
- 無料部分(paywallより前): 800〜1200字。問題提起+概要+「ここから先で得られるもの」
- 有料部分: 具体手順のステップバイステップ、実際の数字、つまずきポイントと回避策、テンプレートや文例
- 有料部分の最後に「月次まとめnote(500円)では1ヶ月分の検証を体系化しています」の予告を1行
- paywall位置に単独行で「<!--paywall-->」を必ず挿入`
      : isMembership
        ? `## 今回の依頼: メンバーシップ限定記事(月額500円のメンバー向け)
- 分量: 2500〜3500字
- 内容: 「今週の海外AI副業 裏話」— 今週検証したネタの本音・失敗談・数字の生データ・来週試すことの先出し
- メンバーだけに話す距離感(「ここだけの話」感)。ただし煽らない
- 冒頭に「メンバーシップ(月500円)限定記事です」と明示
- 全文をメンバー限定として書く(paywallマーカー不要)`
        : `## 今回の依頼: 無料note記事
- 分量: 2000〜3000字
- 全文無料。X投稿では書ききれない深掘り・背景・手順の詳細を提供
- 文中に自然な形で「有料note(100円)でさらに詳しく検証中」の一言を1回だけ入れて良い(押し売り禁止)
`

    const userPrompt = `${spec}

## ネタ
タイトル: ${topic.title_ja}
刺さる理由: ${topic.why_hit || '—'}

## Kai(翻訳担当)による原文の翻訳・要約
${kaiMarkdown.slice(0, 4000)}

## 直近14日のnoteタイトル(重複回避)
${recentTitles}

## 既存の用語注釈集(同じ固有名詞はこの注釈を使う)
${glossaryNote}`

    const llm: LlmResult = await callOpenAI(apiKey, 'gpt-5', YUTO_NOTE_SYSTEM, userPrompt, 24000, 'high') // 推論(high)+長文本文の予算
    if (!llm.ok) {
      result.error = `note執筆失敗: ${llm.error}`
      return result
    }
    result.costUsd = llm.costUsd || 0

    let bodyMd = llm.content.trim()

    // タイトル抽出(1行目の # )
    const titleMatch = bodyMd.match(/^#\s+(.+)$/m)
    const title = (titleMatch ? titleMatch[1] : topic.title_ja).trim().slice(0, 100)

    // paywall位置(有料のみ): <!--paywall--> の文字オフセット
    let paywallPosition: number | null = null
    if (isPaid) {
      const idx = bodyMd.indexOf('<!--paywall-->')
      if (idx >= 0) {
        paywallPosition = idx
      } else {
        // マーカーが無い場合は本文の1/3地点の直近段落境界に挿入
        const third = Math.floor(bodyMd.length / 3)
        const breakIdx = bodyMd.indexOf('\n\n', third)
        const insertAt = breakIdx > 0 ? breakIdx + 2 : third
        bodyMd = bodyMd.slice(0, insertAt) + '<!--paywall-->\n\n' + bodyMd.slice(insertAt)
        paywallPosition = insertAt
      }
    }

    // Mio QA(キーワードエンジン)+1回だけ自動リライト
    let qa = runQaCheck(bodyMd, /\bhttps?:\/\//.test(bodyMd))
    if (qa.status !== 'ok') {
      const rewrite = await callOpenAI(
        apiKey,
        'gpt-5',
        YUTO_NOTE_SYSTEM,
        `以下のnote記事がQAで指摘を受けました。指摘を解消しつつ構成・分量・${isPaid ? 'paywallマーカー(<!--paywall-->)' : '無料記事の形式'}を維持して書き直してください。書き直した記事全文(Markdown)のみを出力:\n\n▓指摘:\n${qa.issues.map((i) => `- ${i.law}: ${i.matched}(${i.detail})`).join('\n')}\n\n▓元の記事:\n${bodyMd}`,
        16000,
        'medium',
      )
      if (rewrite.ok) {
        result.costUsd += rewrite.costUsd || 0
        const qa2 = runQaCheck(rewrite.content, /\bhttps?:\/\//.test(rewrite.content))
        if (qa2.status === 'ok' || (qa2.status === 'needs_fix' && qa.status === 'ng')) {
          bodyMd = rewrite.content.trim()
          if (isPaid) {
            const idx2 = bodyMd.indexOf('<!--paywall-->')
            paywallPosition = idx2 >= 0 ? idx2 : paywallPosition
          }
          qa = qa2
        }
      }
    }

    // アフィリエイトリンク自動埋め込み(文末に▼リンク+#PR)
    bodyMd = await autoEmbedAffiliate(db, bodyMd)

    const articleId = `na-${Date.now()}`
    await db
      .prepare(
        `INSERT INTO note_articles (article_id, topic_id, title, type, price_yen, body_md, paywall_position, approval_status, qa_status, qa_issues)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .bind(articleId, topic.topic_id, title, type, priceYen, bodyMd, paywallPosition, qa.status, JSON.stringify(qa.issues))
      .run()

    result.ok = true
    result.articleId = articleId
    result.title = title
    result.qaStatus = qa.status
    return result
  } catch (e: any) {
    result.error = e?.message || 'note執筆エラー'
    return result
  }
}

// ============================================================
// 月次まとめnote(¥500): 毎月1日に前月の全検証を体系化した主力商品を執筆
// 材料: 前月の公開note記事タイトル+売上実績+KPI推移+Rui月次レポート
// ============================================================
export async function runMonthlySummaryNote(db: D1Database, apiKey: string): Promise<NoteWriterResult> {
  const result: NoteWriterResult = { ok: false, type: 'monthly_summary', costUsd: 0 }
  try {
    // 対象月(前月, JST)
    const jst = new Date(Date.now() + 9 * 3600 * 1000)
    jst.setUTCDate(0) // 前月末日
    const ym = jst.toISOString().slice(0, 7) // YYYY-MM

    // 重複ガード: 同月分が既にあればスキップ
    const dup = await db
      .prepare(`SELECT article_id FROM note_articles WHERE type = 'monthly_summary' AND title LIKE ? LIMIT 1`)
      .bind(`%${ym.replace('-', '年')}月%`).first()
    const dup2 = await db
      .prepare(`SELECT article_id FROM note_articles WHERE type = 'monthly_summary' AND created_at >= date('now', 'start of month') LIMIT 1`)
      .first()
    if (dup || dup2) {
      result.ok = true
      result.error = '今月分は作成済みのためスキップ'
      return result
    }

    // 前月の記事(タイトル+種別+売上)
    const arts = await db
      .prepare(
        `SELECT title, type, price_yen, sales_count, revenue_yen, view_count FROM note_articles
         WHERE created_at >= date('now', 'start of month', '-1 month') AND created_at < date('now', 'start of month')
         ORDER BY created_at ASC LIMIT 40`,
      )
      .all()
    const artText = ((arts.results || []) as any[])
      .map((a) => `- [${a.type}${a.price_yen ? `¥${a.price_yen}` : ''}] ${a.title}(view${a.view_count || 0}/売上${a.sales_count || 0}件)`)
      .join('\n') || '(前月の記事なし — 今月開始のためこれまでの検証全体を材料にする)'

    // KPI推移(30日)
    const kpis = await db
      .prepare(`SELECT date, x_followers, note_paid_sales, affiliate_revenue FROM kpi_daily WHERE date > date('now', '-31 days') ORDER BY date ASC`)
      .all()
    const kpiText = ((kpis.results || []) as any[])
      .map((k) => `${k.date}: フォロワー${k.x_followers} / note売上${k.note_paid_sales}円 / アフィ${k.affiliate_revenue}円`)
      .join('\n') || '(KPIデータなし)'

    // Rui月次レポート(あれば)
    const rui: any = await db
      .prepare(`SELECT body_md FROM analysis_reports WHERE report_type = 'monthly' ORDER BY report_date DESC LIMIT 1`)
      .first()

    const [yy, mm] = ym.split('-')
    const monthJa = `${yy}年${Number(mm)}月`

    const userPrompt = `## 今回の依頼: 月次まとめnote記事(500円 — 当アカウントの主力商品)
- タイトルは「${monthJa}」を含める(例:「${monthJa} 海外AI副業 検証まとめ|試した全ネタと結果」)
- 分量: 5000〜7000字
- 構成(指示書準拠):
  1. 導入(無料・500字): この1ヶ月何を検証したかの全体像
  2. 概要(無料・800字): 今月のハイライト3つ。ここで「この先に何があるか」を明示
  <!--paywall-->
  3. 検証の詳細×2〜3本: それぞれ何を試し、何が起き、何が学びだったか
  4. 実践手順(1500字): 読者が今日から真似できるステップバイステップ
  5. まとめと来月の予告
  6. 出典・参考リンク
  7. 文末: 有料単発note(100円)への自然な誘導1〜2行
- paywall位置(概要の直後)に単独行で「<!--paywall-->」を必ず挿入
- 単発記事(100円)の寄せ集めではなく「体系化・比較・結論」の編集価値を出す

## 前月(${monthJa})に公開した記事一覧
${artText}

## KPI推移(直近30日)
${kpiText}

## Rui(分析担当)の月次レポート
${rui?.body_md ? String(rui.body_md).slice(0, 3000) : '(なし)'}`

    const llm: LlmResult = await callOpenAI(apiKey, 'gpt-5', YUTO_NOTE_SYSTEM, userPrompt, 24000, 'high')
    if (!llm.ok) {
      result.error = `月次まとめ執筆失敗: ${llm.error}`
      return result
    }
    result.costUsd = llm.costUsd || 0

    let bodyMd = llm.content.trim()
    const titleMatch = bodyMd.match(/^#\s+(.+)$/m)
    const title = (titleMatch ? titleMatch[1] : `${monthJa} 海外AI副業 検証まとめ`).trim().slice(0, 100)

    let paywallPosition: number | null = null
    const idx = bodyMd.indexOf('<!--paywall-->')
    if (idx >= 0) {
      paywallPosition = idx
    } else {
      const quarter = Math.floor(bodyMd.length / 4)
      const breakIdx = bodyMd.indexOf('\n\n', quarter)
      const insertAt = breakIdx > 0 ? breakIdx + 2 : quarter
      bodyMd = bodyMd.slice(0, insertAt) + '<!--paywall-->\n\n' + bodyMd.slice(insertAt)
      paywallPosition = insertAt
    }

    // QA + 1回だけ自動リライト
    let qa = runQaCheck(bodyMd, /\bhttps?:\/\//.test(bodyMd))
    if (qa.status !== 'ok') {
      const rewrite = await callOpenAI(
        apiKey, 'gpt-5', YUTO_NOTE_SYSTEM,
        `以下の月次まとめnote記事がQAで指摘を受けました。指摘を解消しつつ構成・分量・paywallマーカー(<!--paywall-->)を維持して書き直してください。書き直した記事全文(Markdown)のみを出力:\n\n▓指摘:\n${qa.issues.map((i) => `- ${i.law}: ${i.matched}(${i.detail})`).join('\n')}\n\n▓元の記事:\n${bodyMd}`,
        20000, 'medium',
      )
      if (rewrite.ok) {
        result.costUsd += rewrite.costUsd || 0
        const qa2 = runQaCheck(rewrite.content, /\bhttps?:\/\//.test(rewrite.content))
        if (qa2.status === 'ok' || (qa2.status === 'needs_fix' && qa.status === 'ng')) {
          bodyMd = rewrite.content.trim()
          const idx2 = bodyMd.indexOf('<!--paywall-->')
          paywallPosition = idx2 >= 0 ? idx2 : paywallPosition
          qa = qa2
        }
      }
    }

    const articleId = `na-ms-${Date.now()}`
    await db
      .prepare(
        `INSERT INTO note_articles (article_id, topic_id, title, type, price_yen, body_md, paywall_position, approval_status, qa_status, qa_issues)
         VALUES (?, NULL, ?, 'monthly_summary', 500, ?, ?, 'pending', ?, ?)`,
      )
      .bind(articleId, title, bodyMd, paywallPosition, qa.status, JSON.stringify(qa.issues))
      .run()

    result.ok = true
    result.articleId = articleId
    result.title = title
    result.qaStatus = qa.status
    return result
  } catch (e: any) {
    result.error = e?.message || '月次まとめ執筆エラー'
    return result
  }
}
