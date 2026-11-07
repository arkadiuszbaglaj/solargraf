/** Sesja użytkownika (D30): /api/auth/login, /api/auth/me, /api/auth/logout. */

export type Role = 'OWNER' | 'ADMIN' | 'VIEWER'

export interface Session {
  user: { id: string; email: string; displayName: string }
  memberships: { organizationId: string; organizationName: string; role: Role }[]
  csrfToken: string
}

export type SessionResult = { kind: 'ok'; session: Session } | { kind: 'anonymous' } | { kind: 'error' }

export type LoginResult = { ok: true; session: Session } | { ok: false; message: string }

const ROLES: ReadonlySet<string> = new Set(['OWNER', 'ADMIN', 'VIEWER'])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

/** Walidacja odpowiedzi API na granicy (CLAUDE.md) — nieznany kształt to błąd, nie zgadywanie. */
export function parseSession(body: unknown): Session | null {
  if (!isRecord(body) || !isRecord(body.user) || !Array.isArray(body.memberships)) return null
  const id = str(body.user.id)
  const email = str(body.user.email)
  const displayName = str(body.user.display_name)
  const csrfToken = str(body.csrf_token)
  if (!id || !email || displayName === null || !csrfToken) return null
  const memberships: Session['memberships'] = []
  for (const m of body.memberships) {
    if (!isRecord(m)) return null
    const organizationId = str(m.organization_id)
    const organizationName = str(m.organization_name)
    const role = str(m.role)
    if (!organizationId || organizationName === null || !role || !ROLES.has(role)) return null
    memberships.push({ organizationId, organizationName, role: role as Role })
  }
  return { user: { id, email, displayName }, memberships, csrfToken }
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

export async function getSession(fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<SessionResult> {
  let response: Response
  try {
    response = await fetchFn('/api/auth/me', { credentials: 'same-origin', ...(signal ? { signal } : {}) })
  } catch {
    return { kind: 'error' }
  }
  if (response.status === 401) return { kind: 'anonymous' }
  if (!response.ok) return { kind: 'error' }
  const session = parseSession(await json(response))
  return session ? { kind: 'ok', session } : { kind: 'error' }
}

export const LOGIN_FAILED =
  'Nieprawidłowy e-mail lub hasło. Po kilku nieudanych próbach konto jest czasowo blokowane.'

export async function login(email: string, password: string, fetchFn: typeof fetch = fetch): Promise<LoginResult> {
  let response: Response
  try {
    response = await fetchFn('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ email, password }),
    })
  } catch {
    return { ok: false, message: 'Brak połączenia z serwerem.' }
  }
  if (response.status === 401) return { ok: false, message: LOGIN_FAILED }
  if (response.status === 422) return { ok: false, message: 'Podaj e-mail i hasło.' }
  if (!response.ok) return { ok: false, message: 'Logowanie nie powiodło się. Spróbuj ponownie za chwilę.' }
  const session = parseSession(await json(response))
  return session ? { ok: true, session } : { ok: false, message: 'Nieoczekiwana odpowiedź serwera.' }
}

export async function logout(csrfToken: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchFn('/api/auth/logout', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfToken },
      credentials: 'same-origin',
    })
    // 401: sesja już nie istnieje — efekt ten sam.
    return response.status === 204 || response.status === 401
  } catch {
    return false
  }
}

/** Tylko ścieżka w tej samej aplikacji (bez otwartego przekierowania na inny host). */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/'
  if (next.startsWith('/login') || next.startsWith('/setup')) return '/'
  return next
}

/** Pełne przejście strony (nowy stan aplikacji po zalogowaniu/wylogowaniu). */
export function assignLocation(url: string): void {
  window.location.assign(url)
}

export function loginUrl(reason?: 'expired'): string {
  const params = new URLSearchParams()
  const here = window.location.pathname + window.location.search
  if (here !== '/') params.set('next', here)
  if (reason) params.set('reason', reason)
  const query = params.toString()
  return query ? `/login?${query}` : '/login'
}

// E-mail z /setup do /login przechodzi przez sessionStorage, nie przez adres URL.
const EMAIL_KEY = 'solargraf.loginEmail'

export function rememberLoginEmail(email: string): void {
  try {
    window.sessionStorage.setItem(EMAIL_KEY, email)
  } catch {
    // Magazyn niedostępny (np. tryb prywatny) — pole zostanie puste.
  }
}

export function takeLoginEmail(): string {
  try {
    const email = window.sessionStorage.getItem(EMAIL_KEY) ?? ''
    window.sessionStorage.removeItem(EMAIL_KEY)
    return email
  } catch {
    return ''
  }
}
