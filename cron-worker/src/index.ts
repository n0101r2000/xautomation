// 毎時10分に xautomation の /api/cron/run を CRON_SECRET 付きで呼ぶだけの Worker
interface Env {
  TARGET_URL: string
  CRON_SECRET: string
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        const res = await fetch(env.TARGET_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.CRON_SECRET}` },
        })
        const body = await res.text()
        // 結果は Cloudflare のログ(Workers → xautomation-cron → Logs)で確認できる
        console.log(`HTTP ${res.status} ${body.slice(0, 500)}`)
        if (!res.ok) throw new Error(`cron tick failed: HTTP ${res.status}`)
      })(),
    )
  },
}
