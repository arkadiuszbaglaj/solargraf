import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { routeFor } from '../Root'
import { AuthGate, SESSION_CHECK_MS } from './AuthGate'
import { useOptionalSession } from './SessionContext'

const BODY = {
  user: { id: 'u1', email: 'jan@example.pl', display_name: 'Jan Kowalski' },
  memberships: [],
  csrf_token: 'csrf',
}

const response = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status })

function Probe() {
  const auth = useOptionalSession()
  return auth ? (
    <button type="button" onClick={auth.logout}>
      Wyloguj {auth.session.user.displayName}
    </button>
  ) : null
}

describe('AuthGate', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('bez sesji przekierowuje na logowanie i nie pokazuje treści', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(401))
    const navigate = vi.fn<(url: string) => void>()
    render(
      <AuthGate fetchFn={fetchFn} navigate={navigate}>
        <p>Treść chroniona</p>
      </AuthGate>,
    )
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/login'))
    expect(screen.queryByText('Treść chroniona')).toBeNull()
  })

  it('z sesją pokazuje treść, a wylogowanie wysyła CSRF i wraca do logowania', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, BODY))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    const navigate = vi.fn<(url: string) => void>()
    render(
      <AuthGate fetchFn={fetchFn} navigate={navigate}>
        <Probe />
      </AuthGate>,
    )
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Wyloguj Jan Kowalski' }))
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/login'))
    const [url, init] = fetchFn.mock.calls[1] ?? []
    expect(url).toBe('/api/auth/logout')
    expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('csrf')
  })

  it('po wygaśnięciu sesji w trakcie pracy wraca do logowania z powodem', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, BODY))
      .mockResolvedValue(response(401))
    const navigate = vi.fn<(url: string) => void>()
    render(
      <AuthGate fetchFn={fetchFn} navigate={navigate}>
        <Probe />
      </AuthGate>,
    )
    await screen.findByRole('button')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_CHECK_MS)
    })
    expect(navigate).toHaveBeenCalledWith('/login?reason=expired')
  })

  it('przy błędzie serwera pokazuje błąd z ponowieniem, bez przekierowania', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200, BODY))
    const navigate = vi.fn<(url: string) => void>()
    render(
      <AuthGate fetchFn={fetchFn} navigate={navigate}>
        <Probe />
      </AuthGate>,
    )
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Spróbuj ponownie' }))
    expect(await screen.findByRole('button', { name: 'Wyloguj Jan Kowalski' })).toBeTruthy()
    expect(navigate).not.toHaveBeenCalled()
  })
})

describe('routeFor', () => {
  it.each([
    ['/setup', 'setup'],
    ['/login', 'login'],
    ['/', 'app'],
    ['/cokolwiek', 'app'],
  ])('%s → %s', (path, route) => {
    expect(routeFor(path)).toBe(route)
  })
})
