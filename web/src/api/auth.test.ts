import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LOGIN_FAILED,
  getSession,
  login,
  loginUrl,
  logout,
  parseSession,
  rememberLoginEmail,
  safeNext,
  takeLoginEmail,
} from './auth'

const BODY = {
  user: { id: 'u1', email: 'jan@example.pl', display_name: 'Jan' },
  memberships: [{ organization_id: 'o1', organization_name: 'Dom', role: 'OWNER' }],
  csrf_token: 'csrf',
}

const reply = (status: number, body: unknown = {}) =>
  vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status }))

describe('parseSession', () => {
  it('mapuje poprawną odpowiedź', () => {
    expect(parseSession(BODY)).toEqual({
      user: { id: 'u1', email: 'jan@example.pl', displayName: 'Jan' },
      memberships: [{ organizationId: 'o1', organizationName: 'Dom', role: 'OWNER' }],
      csrfToken: 'csrf',
    })
  })

  it.each([
    null,
    {},
    { ...BODY, csrf_token: '' },
    { ...BODY, user: { id: 'u1' } },
    { ...BODY, memberships: [{ organization_id: 'o1', organization_name: 'Dom', role: 'ROOT' }] },
    { ...BODY, memberships: 'x' },
  ])('odrzuca nieznany kształt %#', (body) => {
    expect(parseSession(body)).toBeNull()
  })
})

describe('getSession', () => {
  it('rozróżnia sesję, brak sesji i błąd', async () => {
    expect((await getSession(reply(200, BODY))).kind).toBe('ok')
    expect((await getSession(reply(401))).kind).toBe('anonymous')
    expect((await getSession(reply(500))).kind).toBe('error')
    expect((await getSession(reply(200, { nie: 'sesja' }))).kind).toBe('error')
    expect((await getSession(vi.fn<typeof fetch>().mockRejectedValue(new TypeError('net')))).kind).toBe('error')
  })
})

describe('login', () => {
  it('wysyła e-mail i hasło', async () => {
    const fetchFn = reply(200, BODY)
    const result = await login('jan@example.pl', 'haslo', fetchFn)
    expect(result.ok).toBe(true)
    const [url, init] = fetchFn.mock.calls[0] ?? []
    expect(url).toBe('/api/auth/login')
    expect(JSON.parse(String(init?.body))).toEqual({ email: 'jan@example.pl', password: 'haslo' })
  })

  it('nie zdradza, czy konto istnieje lub jest zablokowane', async () => {
    expect(await login('a@b.pl', 'x', reply(401, { detail: 'konto zablokowane' }))).toEqual({
      ok: false,
      message: LOGIN_FAILED,
    })
  })

  it('obsługuje brak połączenia', async () => {
    const offline = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('net'))
    expect(await login('a@b.pl', 'x', offline)).toEqual({ ok: false, message: 'Brak połączenia z serwerem.' })
  })
})

describe('logout', () => {
  it('wysyła token CSRF i akceptuje już wygasłą sesję', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
    expect(await logout('csrf', fetchFn)).toBe(true)
    expect(new Headers(fetchFn.mock.calls[0]?.[1]?.headers).get('X-CSRF-Token')).toBe('csrf')
    expect(await logout('csrf', reply(401))).toBe(true)
    expect(await logout('csrf', reply(403))).toBe(false)
  })
})

describe('safeNext', () => {
  it.each([
    [null, '/'],
    ['/', '/'],
    ['/historia?d=1', '/historia?d=1'],
    ['https://zly.example', '/'],
    ['//zly.example', '/'],
    ['/\\zly.example', '/'],
    ['/login', '/'],
    ['/setup?token=x', '/'],
  ])('%s → %s', (next, expected) => {
    expect(safeNext(next)).toBe(expected)
  })
})

describe('loginUrl i e-mail', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/')
  })

  it('zapamiętuje bieżącą ścieżkę i powód', () => {
    window.history.replaceState(null, '', '/historia?d=1')
    expect(loginUrl('expired')).toBe('/login?next=%2Fhistoria%3Fd%3D1&reason=expired')
    window.history.replaceState(null, '', '/')
    expect(loginUrl()).toBe('/login')
  })

  it('przekazuje e-mail jednorazowo, poza adresem URL', () => {
    rememberLoginEmail('jan@example.pl')
    expect(takeLoginEmail()).toBe('jan@example.pl')
    expect(takeLoginEmail()).toBe('')
  })
})
