// Aki(画像): 画像増産体制 (1日10枚以上OK)
// - runAkiImagePlan: 全12枠をLLM判定 → 必要な枠に生成(上限8枚/日) → Mio画像QA → 合格分のみX投稿に添付
// - runAkiInfographic: 枠3単体の図解生成(旧フロー・手動用に残置)
// - runAkiNoteCover: noteカバー画像
// - runAkiNoteDiagrams: 有料note本文用の図解(最大2枚/記事)
import { callOpenAI } from './llm'
import { buildImagePrompt, generateImage, qaImage, IMAGE_SIZE, IMAGE_COST_USD, type ImagePurpose } from './image-gen'

const AKI_EXTRACT_SYSTEM = `あなたは「Aki」— 日本のXアカウント「Mさん / 海外AI副業の検証部屋」の画像デザイナーです。
X投稿の原稿から、1枚の図解画像にする内容を設計します。

## 設計ルール
- 図解タイトルは15字以内の日本語(画像に大きく描画される)
- ステップ図・比較図・構造図のいずれかに落とし込む
- 画像内テキストは最小限(タイトル+3〜5個の短いラベル)。長文は入れない
- 「誰でも」「必ず」「簡単に稼げる」等の断定表現は画像内でも禁止

## 出力形式(必ずこのJSONのみ)
{
  "title": "図解タイトル(15字以内)",
  "labels": ["ラベル1", "ラベル2", "ラベル3"],
  "layout_hint": "step diagram with 3 numbered boxes 等、英語のレイアウト指示1文"
}`

export interface AkiResult {
  ok: boolean
  imageId?: string
  title?: string
  qaStatus?: string
  costUsd: number
  error?: string
}

// 枠3投稿の本文から図解画像を生成し、x_posts.image_urls に添付
export async function runAkiInfographic(
  db: D1Database,
  r2: R2Bucket,
  apiKey: string,
  postId: string,
  postBody: string,
  topicTitle: string,
): Promise<AkiResult> {
  const result: AkiResult = { ok: false, costUsd: 0 }
  try {
    // ① 視覚化ポイント抽出
    const extract = await callOpenAI(
      apiKey,
      'gpt-5',
      AKI_EXTRACT_SYSTEM,
      `以下のX投稿(枠3: ノウハウ図解)の原稿から図解を設計してください。\n\n▓ネタ: ${topicTitle}\n▓投稿本文:\n${postBody}`,
      4000,
      'low',
    )
    if (!extract.ok) {
      result.error = `図解設計失敗: ${extract.error}`
      return result
    }
    result.costUsd += extract.costUsd || 0

    let title = topicTitle.slice(0, 15)
    let labels: string[] = []
    let layoutHint = ''
    try {
      const jsonText = extract.content.replace(/^```json?\s*/, '').replace(/```\s*$/, '').trim()
      const parsed = JSON.parse(jsonText)
      if (parsed.title) title = String(parsed.title).slice(0, 20)
      if (Array.isArray(parsed.labels)) labels = parsed.labels.slice(0, 5).map((l: any) => String(l))
      if (parsed.layout_hint) layoutHint = String(parsed.layout_hint)
    } catch {
      /* 抽出失敗時はタイトルのみで生成 */
    }

    const extra = [layoutHint, labels.length ? `Japanese labels: ${labels.map((l) => `"${l}"`).join(', ')}` : ''].filter(Boolean).join(', ')

    // ② 生成 → ③ QA(needs_fix/ng なら1回だけ再生成)
    let finalB64: string | null = null
    let finalQa: any = null
    let prompt = ''
    for (let attempt = 0; attempt < 2; attempt++) {
      prompt = buildImagePrompt('infographic', title, extra + (attempt > 0 ? ', extra attention to accurate Japanese text rendering' : ''))
      const gen = await generateImage(apiKey, prompt, IMAGE_SIZE.infographic)
      if (!gen.ok || !gen.b64) {
        result.error = `画像生成失敗: ${gen.error}`
        if (attempt === 0) continue
        return result
      }
      result.costUsd += IMAGE_COST_USD

      const qa = await qaImage(apiKey, gen.b64, title)
      if (qa.ok) result.costUsd += qa.costUsd || 0
      const verdict = qa.ok ? qa.verdict || 'unknown' : 'unknown'

      finalB64 = gen.b64
      finalQa = { verdict, issues: qa.issues || [], summary: qa.summary || qa.error || '' }
      if (verdict === 'ok') break
      // needs_fix/ng → 再生成(2回目の結果はそのまま採用し、QA状態を記録)
    }

    if (!finalB64) {
      result.error = result.error || '画像生成に失敗しました'
      return result
    }

    // ④ R2保存 + DB登録 + 投稿に添付
    const imageId = `img-auto-${Date.now()}`
    const r2Key = `images/${imageId}.png`
    const binary = Uint8Array.from(atob(finalB64), (ch) => ch.charCodeAt(0))
    await r2.put(r2Key, binary, { httpMetadata: { contentType: 'image/png' } })

    const qaStatus = finalQa?.verdict === 'ok' ? 'ok' : finalQa?.verdict === 'ng' ? 'ng' : 'needs_fix'
    await db
      .prepare(
        `INSERT INTO generated_images (image_id, post_id, purpose, prompt, title_text, r2_key, model, qa_status, qa_issues, cost_usd)
         VALUES (?, ?, 'infographic', ?, ?, ?, 'gpt-image-2', ?, ?, ?)`,
      )
      .bind(imageId, postId, prompt, title, r2Key, qaStatus, JSON.stringify(finalQa?.issues || []), result.costUsd)
      .run()

    await db
      .prepare(`UPDATE x_posts SET image_urls = ? WHERE post_id = ?`)
      .bind(JSON.stringify([`/api/images/${imageId}/file`]), postId)
      .run()

    result.ok = true
    result.imageId = imageId
    result.title = title
    result.qaStatus = qaStatus
    return result
  } catch (e: any) {
    result.error = e?.message || 'Aki実行エラー'
    return result
  }
}

// ============================================================
// note記事のカバー画像を生成(Phase D: 画像増産 — note読了率・購入率の向上)
// 有料記事は購入判断に直結するため必ず、無料記事も毎日生成
// ============================================================
export async function runAkiNoteCover(
  db: D1Database,
  r2: R2Bucket,
  apiKey: string,
  articleId: string,
  articleTitle: string,
  articleType: string,
): Promise<AkiResult> {
  const result: AkiResult = { ok: false, costUsd: 0 }
  try {
    const shortTitle = articleTitle.replace(/[|｜].*$/, '').slice(0, 22)
    const badge = articleType === 'monthly_summary' ? '月次まとめ' : articleType === 'paid_single' ? '有料検証' : articleType === 'membership' ? 'メンバー限定' : ''
    const extra = badge ? `small orange badge label "${badge}" in top-left corner` : ''

    const prompt = buildImagePrompt('note_cover', shortTitle, extra)
    const gen = await generateImage(apiKey, prompt, IMAGE_SIZE.note_cover)
    if (!gen.ok || !gen.b64) {
      result.error = `noteカバー生成失敗: ${gen.error}`
      return result
    }
    result.costUsd += IMAGE_COST_USD

    const qa = await qaImage(apiKey, gen.b64, shortTitle)
    if (qa.ok) result.costUsd += qa.costUsd || 0
    const verdict = qa.ok ? qa.verdict || 'unknown' : 'unknown'
    const qaStatus = verdict === 'ok' ? 'ok' : verdict === 'ng' ? 'ng' : 'needs_fix'

    const imageId = `img-cover-${Date.now()}`
    const r2Key = `images/${imageId}.png`
    const binary = Uint8Array.from(atob(gen.b64), (ch) => ch.charCodeAt(0))
    await r2.put(r2Key, binary, { httpMetadata: { contentType: 'image/png' } })

    await db
      .prepare(
        `INSERT INTO generated_images (image_id, post_id, purpose, prompt, title_text, r2_key, model, qa_status, qa_issues, cost_usd)
         VALUES (?, NULL, 'note_cover', ?, ?, ?, 'gpt-image-2', ?, ?, ?)`,
      )
      .bind(imageId, prompt, shortTitle, r2Key, qaStatus, JSON.stringify(qa.issues || []), result.costUsd)
      .run()

    await db.prepare(`UPDATE note_articles SET cover_image_id = ? WHERE article_id = ?`).bind(imageId, articleId).run()

    result.ok = true
    result.imageId = imageId
    result.title = shortTitle
    result.qaStatus = qaStatus
    return result
  } catch (e: any) {
    result.error = e?.message || 'Akiカバー生成エラー'
    return result
  }
}

// ============================================================
// 画像増産: 全12枠をAkiが判定 → 必要な枠に生成 → Mio(別ワーカー)がQA → 合格分のみ添付
// ============================================================

const AKI_PLAN_SYSTEM = `あなたは「Aki」— 日本のXアカウント「Mさん / 海外AI副業の検証部屋」の画像デザイナーです。
本日の全X投稿(最大12枠)を見て、どの投稿に画像を添付すべきかを判断し、添付する画像を設計します。

## 判断基準
- 画像で理解が深まる投稿(手順・比較・数字・構造の説明)には積極的に付ける
- 短い一言・質問・引用RT・URL誘導のみの投稿には無理に付けない
- 枠3(ノウハウ図解)は必ず画像を付ける
- 全体で最大8枚まで。効果が高い順に選ぶ

## 画像タイプ
- "infographic": 縦長のステップ図・構造図(手順・仕組み解説向き)
- "thumbnail": 横長のアイキャッチ(ニュース速報・事例紹介向き)

## 設計ルール
- title は15字以内の日本語(画像に大きく描画される)
- labels は3〜5個の短い日本語ラベル。長文禁止
- 「誰でも」「必ず」「簡単に稼げる」等の断定表現は画像内でも禁止

## 出力形式(必ずこのJSON配列のみ。画像不要の枠は含めない)
[
  { "slot": 3, "purpose": "infographic", "title": "図解タイトル", "labels": ["ラベル1","ラベル2","ラベル3"], "layout_hint": "step diagram with 3 numbered boxes 等、英語1文", "reason": "選定理由を1文" }
]`

export interface AkiPlanResult {
  ok: boolean
  planned: number       // 画像が必要と判定された枠数
  generated: number     // 生成成功数
  attached: number      // QA合格でX投稿に添付された数
  qaFailed: number      // QA不合格(添付見送り)数
  details: string[]
  costUsd: number
  error?: string
}

// 1枚を生成→Mio QA→R2/DB保存し、QA合格ならpostに添付する共通処理
async function generateQaAndSave(
  db: D1Database,
  r2: R2Bucket,
  apiKey: string,
  purpose: ImagePurpose,
  title: string,
  extra: string,
  postId: string | null,
  idPrefix: string,
): Promise<{ ok: boolean; imageId?: string; qaStatus?: string; attached: boolean; costUsd: number; error?: string }> {
  let costUsd = 0
  let finalB64: string | null = null
  let finalQa: any = null
  let prompt = ''
  // 生成→QA、不合格なら1回だけ再生成
  for (let attempt = 0; attempt < 2; attempt++) {
    prompt = buildImagePrompt(purpose, title, extra + (attempt > 0 ? ', extra attention to accurate Japanese text rendering' : ''))
    const gen = await generateImage(apiKey, prompt, IMAGE_SIZE[purpose])
    if (!gen.ok || !gen.b64) {
      if (attempt === 0) continue
      return { ok: false, attached: false, costUsd, error: `生成失敗: ${gen.error}` }
    }
    costUsd += IMAGE_COST_USD
    const qa = await qaImage(apiKey, gen.b64, title)
    if (qa.ok) costUsd += qa.costUsd || 0
    const verdict = qa.ok ? qa.verdict || 'unknown' : 'unknown'
    finalB64 = gen.b64
    finalQa = { verdict, issues: qa.issues || [], summary: qa.summary || qa.error || '' }
    if (verdict === 'ok') break
  }
  if (!finalB64) return { ok: false, attached: false, costUsd, error: '画像生成に失敗しました' }

  const imageId = `${idPrefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`
  const r2Key = `images/${imageId}.png`
  const binary = Uint8Array.from(atob(finalB64), (ch) => ch.charCodeAt(0))
  await r2.put(r2Key, binary, { httpMetadata: { contentType: 'image/png' } })

  const qaStatus = finalQa?.verdict === 'ok' ? 'ok' : finalQa?.verdict === 'ng' ? 'ng' : 'needs_fix'
  await db
    .prepare(
      `INSERT INTO generated_images (image_id, post_id, purpose, prompt, title_text, r2_key, model, qa_status, qa_issues, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, 'gpt-image-2', ?, ?, ?)`,
    )
    .bind(imageId, postId, purpose, prompt, title, r2Key, qaStatus, JSON.stringify(finalQa?.issues || []), costUsd)
    .run()

  // Mio QA合格分のみX投稿に添付 (needs_fix/ngは記録のみ、添付見送り)
  let attached = false
  if (postId && qaStatus === 'ok') {
    await db
      .prepare(`UPDATE x_posts SET image_urls = ? WHERE post_id = ?`)
      .bind(JSON.stringify([`/api/images/${imageId}/file`]), postId)
      .run()
    attached = true
  }
  return { ok: true, imageId, qaStatus, attached, costUsd }
}

// 本日作成された全枠の投稿を判定し、必要な枠に画像を生成・添付する
export async function runAkiImagePlan(
  db: D1Database,
  r2: R2Bucket,
  apiKey: string,
  posts: { postId: string; slot: number; body: string; topicTitle: string }[],
  maxImages = 8,
): Promise<AkiPlanResult> {
  const result: AkiPlanResult = { ok: false, planned: 0, generated: 0, attached: 0, qaFailed: 0, details: [], costUsd: 0 }
  try {
    if (posts.length === 0) {
      result.ok = true
      return result
    }

    // ① Akiが全枠を見て「どの投稿に画像を付けるか」を判定
    const postList = posts
      .map((p) => `▓枠${p.slot} (ネタ: ${p.topicTitle})\n${p.body.slice(0, 400)}`)
      .join('\n\n')
    const plan = await callOpenAI(
      apiKey,
      'gpt-5',
      AKI_PLAN_SYSTEM,
      `本日の投稿一覧です。画像を添付すべき枠を選び、それぞれの画像を設計してください(最大${maxImages}枚)。\n\n${postList}`,
      8000,
      'low',
    )
    if (!plan.ok) {
      result.error = `画像計画失敗: ${plan.error}`
      return result
    }
    result.costUsd += plan.costUsd || 0

    let items: any[] = []
    try {
      const jsonText = plan.content.replace(/^```json?\s*/, '').replace(/```\s*$/, '').trim()
      const parsed = JSON.parse(jsonText)
      if (Array.isArray(parsed)) items = parsed
    } catch {
      result.error = '画像計画のJSON解析に失敗しました'
      return result
    }

    // 枠3が計画に含まれていなければ必ず追加(指示書: 枠3は図解必須)
    const slot3Post = posts.find((p) => p.slot === 3)
    if (slot3Post && !items.some((it) => Number(it.slot) === 3)) {
      items.unshift({ slot: 3, purpose: 'infographic', title: slot3Post.topicTitle.slice(0, 15), labels: [], layout_hint: 'step diagram with numbered boxes', reason: '枠3は図解必須' })
    }
    items = items.slice(0, maxImages)
    result.planned = items.length

    // ② 各枠: 生成 → Mio QA → 合格分のみ添付
    for (const it of items) {
      const post = posts.find((p) => p.slot === Number(it.slot))
      if (!post) continue
      const purpose: ImagePurpose = it.purpose === 'thumbnail' ? 'thumbnail' : 'infographic'
      const title = String(it.title || post.topicTitle).slice(0, 20)
      const labels: string[] = Array.isArray(it.labels) ? it.labels.slice(0, 5).map((l: any) => String(l)) : []
      const extra = [String(it.layout_hint || ''), labels.length ? `Japanese labels: ${labels.map((l) => `"${l}"`).join(', ')}` : '']
        .filter(Boolean)
        .join(', ')

      const g = await generateQaAndSave(db, r2, apiKey, purpose, title, extra, post.postId, `img-auto-s${post.slot}`)
      result.costUsd += g.costUsd
      if (!g.ok) {
        result.details.push(`枠${post.slot}: 生成失敗 (${g.error})`)
        continue
      }
      result.generated++
      if (g.attached) {
        result.attached++
        result.details.push(`枠${post.slot}: ${title} → QA合格・添付`)
      } else {
        result.qaFailed++
        result.details.push(`枠${post.slot}: ${title} → QA ${g.qaStatus}(添付見送り)`)
      }
    }

    result.ok = true
    return result
  } catch (e: any) {
    result.error = e?.message || 'Aki画像計画エラー'
    return result
  }
}

// ============================================================
// 有料note本文用の図解生成 (D-1③): 記事本文から図解ポイントを抽出し最大2枚生成
// QA合格分のみ note_articles.body_images に記録 → ゲート③で表示・DL
// ============================================================

const AKI_NOTE_DIAGRAM_SYSTEM = `あなたは「Aki」— note記事の本文に挿入する図解のデザイナーです。
記事本文を読み、読者の理解を助ける図解を最大2枚設計します。

## 設計ルール
- 図解1枚目は記事の核となる手順・構造(有料パートの価値を高めるもの)
- 図解2枚目は比較表・数字のまとめ等(不要なら1枚だけでもよい)
- title は15字以内の日本語
- labels は3〜5個の短い日本語ラベル
- 断定的な利益表現(「誰でも」「必ず」等)は禁止

## 出力形式(必ずこのJSON配列のみ、1〜2要素)
[
  { "title": "図解タイトル", "labels": ["ラベル1","ラベル2"], "layout_hint": "flowchart with 4 steps 等、英語1文", "insert_hint": "本文のどこに挿入するか日本語1文" }
]`

export interface AkiNoteDiagramResult {
  ok: boolean
  generated: number
  imageIds: string[]
  costUsd: number
  error?: string
}

export async function runAkiNoteDiagrams(
  db: D1Database,
  r2: R2Bucket,
  apiKey: string,
  articleId: string,
  articleTitle: string,
  bodyMd: string,
): Promise<AkiNoteDiagramResult> {
  const result: AkiNoteDiagramResult = { ok: false, generated: 0, imageIds: [], costUsd: 0 }
  try {
    // ① 図解設計
    const plan = await callOpenAI(
      apiKey,
      'gpt-5',
      AKI_NOTE_DIAGRAM_SYSTEM,
      `以下のnote記事の本文用図解を設計してください。\n\n▓タイトル: ${articleTitle}\n▓本文:\n${bodyMd.slice(0, 4000)}`,
      6000,
      'low',
    )
    if (!plan.ok) {
      result.error = `図解設計失敗: ${plan.error}`
      return result
    }
    result.costUsd += plan.costUsd || 0

    let items: any[] = []
    try {
      const jsonText = plan.content.replace(/^```json?\s*/, '').replace(/```\s*$/, '').trim()
      const parsed = JSON.parse(jsonText)
      if (Array.isArray(parsed)) items = parsed.slice(0, 2)
    } catch {
      result.error = '図解設計のJSON解析に失敗しました'
      return result
    }
    if (items.length === 0) {
      result.ok = true
      return result
    }

    // ② 生成 → Mio QA → 保存 (post_id=NULL, purpose=note_diagram)
    const okImages: { imageId: string; title: string; insertHint: string }[] = []
    for (const it of items) {
      const title = String(it.title || articleTitle).slice(0, 20)
      const labels: string[] = Array.isArray(it.labels) ? it.labels.slice(0, 5).map((l: any) => String(l)) : []
      const extra = [String(it.layout_hint || ''), labels.length ? `Japanese labels: ${labels.map((l) => `"${l}"`).join(', ')}` : '']
        .filter(Boolean)
        .join(', ')
      const g = await generateQaAndSave(db, r2, apiKey, 'note_diagram', title, extra, null, 'img-nd')
      result.costUsd += g.costUsd
      if (g.ok && g.imageId) {
        result.generated++
        result.imageIds.push(g.imageId)
        // 記事との紐付け (QA不合格でも記録はする — ゲート③でQA状態ごと確認できる)
        await db.prepare(`UPDATE generated_images SET article_id = ? WHERE image_id = ?`).bind(articleId, g.imageId).run()
        if (g.qaStatus === 'ok') okImages.push({ imageId: g.imageId, title, insertHint: String(it.insert_hint || '') })
      }
    }

    result.ok = true
    return result
  } catch (e: any) {
    result.error = e?.message || 'Aki本文図解エラー'
    return result
  }
}
