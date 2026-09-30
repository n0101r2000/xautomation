// Sora (SNS管理): 承認済み投稿の自動予約投稿
// 毎時cronから呼ばれ、scheduled_at が到来した承認済み投稿をXへ投稿する
// - 枠3: QA通過画像を添付
// - 枠6: quote_tweet_id があれば引用RT (投稿直前に生存確認、消えていれば通常投稿)
// - X APIキー未設定時は何もしない (エラーにしない)

import { getXCredentials, postTweet, uploadMedia, isTransientXError, X_PREMIUM_CHAR_LIMIT, type XCredentials } from './x-api'
import { verifyTweetAlive } from './sources'

export interface SoraPublishResult {
  ok: boolean
  published: number       // 今回投稿した件数
  skippedNoCreds: boolean // キー未設定でスキップ
  details: string[]       // 各投稿の結果
  errors: string[]
}

// 1件をXへ投稿 (画像・引用RT・長文スレッド対応) — 手動publish-xとcron両方から使う
export async function publishPostToX(
  db: D1Database,
  r2: R2Bucket,
  creds: XCredentials,
  post: any,
): Promise<{ ok: boolean; tweetId?: string; tweetUrl?: string; withImage: boolean; quoted: boolean; threaded: boolean; threadCount?: number; error?: string }> {
  // 画像 (QA通過分のみ)
  let mediaIds: string[] = []
  const img: any = await db
    .prepare("SELECT * FROM generated_images WHERE post_id = ? AND qa_status = 'ok' ORDER BY created_at DESC LIMIT 1")
    .bind(post.post_id).first()
  if (img) {
    const obj = await r2.get(img.r2_key)
    if (obj) {
      const buf = await obj.arrayBuffer()
      const bytes = new Uint8Array(buf)
      let b64 = ''
      const chunk = 0x8000
      for (let i = 0; i < bytes.length; i += chunk) b64 += String.fromCharCode(...bytes.subarray(i, i + chunk))
      const up = await uploadMedia(creds, btoa(b64))
      if (up.ok && up.mediaId) mediaIds = [up.mediaId]
    }
  }

  // 引用RT: 投稿直前に引用元の生存確認
  let quoteId: string | undefined
  if (post.quote_tweet_id) {
    const screenName = (post.quote_author || '').replace(/^@/, '')
    const alive = screenName ? await verifyTweetAlive(post.quote_tweet_id, screenName) : false
    if (alive) quoteId = post.quote_tweet_id
    // 消えていた場合は通常投稿として本文のみ投稿 (本文は引用なしでも成立する書き方をYutoに指示済み)
  }

  // X Premium加入済み: 長文も1投稿で完結(最大25,000字)。ツリー/スレッド分割は廃止。
  // 万一上限を超える本文は末尾を安全に切り詰める(通常は発生しない)
  const body = [...post.body].length > X_PREMIUM_CHAR_LIMIT
    ? [...post.body].slice(0, X_PREMIUM_CHAR_LIMIT - 1).join('') + '…'
    : post.body

  const result = await postTweet(creds, body, mediaIds.length ? mediaIds : undefined, quoteId)
  if (!result.ok) return { ok: false, withImage: mediaIds.length > 0, quoted: !!quoteId, threaded: false, error: result.error }

  await db.prepare("UPDATE x_posts SET published_at = datetime('now'), buffer_id = ? WHERE post_id = ?")
    .bind(result.tweetId, post.post_id).run()

  return { ok: true, tweetId: result.tweetId, tweetUrl: result.tweetUrl, withImage: mediaIds.length > 0, quoted: !!quoteId, threaded: false }
}

// 毎時実行: scheduled_at 到来分の承認済み投稿を投稿
export async function runSoraScheduledPublish(
  db: D1Database,
  r2: R2Bucket,
  env: Record<string, string | undefined>,
): Promise<SoraPublishResult> {
  const result: SoraPublishResult = { ok: true, published: 0, skippedNoCreds: false, details: [], errors: [] }

  const creds = getXCredentials(env)
  if (!creds) {
    result.skippedNoCreds = true
    return result
  }

  // 時刻到来 & 承認済み & 未投稿 & QA非NG (取りこぼし救済のため24時間まで遡る)
  const due = await db.prepare(
    `SELECT * FROM x_posts
     WHERE approval_status = 'approved' AND published_at IS NULL AND qa_status != 'ng'
       AND scheduled_at <= datetime('now')
       AND scheduled_at >= datetime('now', '-24 hours')
     ORDER BY scheduled_at ASC LIMIT 5`,
  ).all()

  for (const post of (due.results || []) as any[]) {
    try {
      const r = await publishPostToX(db, r2, creds, post)
      if (r.ok) {
        result.published++
        const tags = [r.withImage ? '画像付き' : '', r.quoted ? '引用RT' : ''].filter(Boolean).join('/')
        result.details.push(`枠${post.slot_number}: ${r.tweetUrl}${tags ? ` (${tags})` : ''}`)
        await db.prepare(
          "INSERT INTO worker_logs (worker_name, action, status, output_json, finished_at) VALUES ('sora', 'auto_publish', 'success', ?, CURRENT_TIMESTAMP)",
        ).bind(`枠${post.slot_number}を自動投稿: ${r.tweetUrl}${r.quoted ? ' (引用RT)' : ''}`).run()
      } else {
        result.errors.push(`枠${post.slot_number}: ${r.error}`)
        // 恒久エラー(重複コンテンツ等)は rejected に戻して毎時リトライを止める。
        // 一時的エラー(レート制限・5xx・ネットワーク)のみ次回リトライに残す(24hウィンドウ内)。
        const isTransient = isTransientXError(r.error)
        if (!isTransient) {
          await db.prepare("UPDATE x_posts SET approval_status = 'rejected' WHERE post_id = ?").bind(post.post_id).run()
        }
        await db.prepare(
          "INSERT INTO worker_logs (worker_name, action, status, output_json, finished_at) VALUES ('sora', 'auto_publish', 'error', ?, CURRENT_TIMESTAMP)",
        ).bind(`枠${post.slot_number}の投稿失敗: ${r.error}${isTransient ? '(次回リトライ)' : '(承認取消 — 内容を確認して再承認してください)'}`).run()
      }
      await new Promise((resolve) => setTimeout(resolve, 1500)) // レートリミット配慮
    } catch (e: any) {
      result.errors.push(`枠${post.slot_number}: ${e?.message || 'error'}`)
    }
  }

  if (result.errors.length > 0 && result.published === 0) result.ok = false
  return result
}
