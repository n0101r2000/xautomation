// アプリ内認証(メールアドレス+パスワード / PBKDF2 + セッションCookie)
// Workers対応: Web Crypto APIのみ使用

export const ALLOWED_EMAILS = ['d.omori@dissectera.com']
const SESSION_DAYS = 30
const PBKDF2_ITERATIONS = 100_000

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return toHex(arr.buffer)
}

export async function hashPassword(password: string, saltHex: string): Promise<string> {
  const enc = new TextEncoder()
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)))
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256,
  )
  return toHex(bits)
}

export function newSalt(): string {
  return randomHex(16)
}

export function newSessionToken(): string {
  return randomHex(32)
}

// タイミング攻撃対策の定数時間比較
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export interface AuthState {
  registered: boolean // 許可メールにパスワード設定済みか
  email: string | null // ログイン中のメール(未ログインはnull)
}

export async function getAuthState(db: D1Database, sessionToken: string | null): Promise<AuthState> {
  const userRow = await db
    .prepare(`SELECT email FROM auth_users WHERE email IN (${ALLOWED_EMAILS.map(() => '?').join(',')}) LIMIT 1`)
    .bind(...ALLOWED_EMAILS)
    .first()
  const registered = !!userRow
  if (!sessionToken) return { registered, email: null }
  const session = await db
    .prepare(`SELECT email FROM auth_sessions WHERE token = ? AND expires_at > datetime('now')`)
    .bind(sessionToken)
    .first<{ email: string }>()
  return { registered, email: session?.email || null }
}

export async function registerUser(db: D1Database, email: string, password: string): Promise<{ ok: boolean; error?: string }> {
  const normalized = email.trim().toLowerCase()
  if (!ALLOWED_EMAILS.includes(normalized)) return { ok: false, error: 'このメールアドレスは登録を許可されていません' }
  if (password.length < 8) return { ok: false, error: 'パスワードは8文字以上にしてください' }
  const existing = await db.prepare('SELECT email FROM auth_users WHERE email = ?').bind(normalized).first()
  if (existing) return { ok: false, error: 'すでに登録済みです。ログインしてください' }
  const salt = newSalt()
  const hash = await hashPassword(password, salt)
  await db.prepare('INSERT INTO auth_users (email, password_hash, salt) VALUES (?, ?, ?)').bind(normalized, hash, salt).run()
  return { ok: true }
}

export async function loginUser(db: D1Database, email: string, password: string): Promise<{ ok: boolean; token?: string; error?: string }> {
  const normalized = email.trim().toLowerCase()
  const user = await db
    .prepare('SELECT email, password_hash, salt FROM auth_users WHERE email = ?')
    .bind(normalized)
    .first<{ email: string; password_hash: string; salt: string }>()
  if (!user) return { ok: false, error: 'メールアドレスまたはパスワードが違います' }
  const hash = await hashPassword(password, user.salt)
  if (!safeEqual(hash, user.password_hash)) return { ok: false, error: 'メールアドレスまたはパスワードが違います' }
  const token = newSessionToken()
  await db
    .prepare(`INSERT INTO auth_sessions (token, email, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`)
    .bind(token, normalized)
    .run()
  // 期限切れセッションを掃除
  await db.prepare(`DELETE FROM auth_sessions WHERE expires_at <= datetime('now')`).run()
  return { ok: true, token }
}

export async function logoutUser(db: D1Database, token: string): Promise<void> {
  await db.prepare('DELETE FROM auth_sessions WHERE token = ?').bind(token).run()
}

export function sessionCookie(token: string): string {
  return `session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`
}

export function clearSessionCookie(): string {
  return 'session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
}

export function parseSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null
  const m = cookieHeader.match(/(?:^|;\s*)session=([a-f0-9]{64})/)
  return m ? m[1] : null
}
