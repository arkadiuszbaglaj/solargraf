import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { parseServerTime } from '../api/health'
import type { Role, Session } from '../api/auth'
import { SessionProvider } from '../auth/SessionContext'
import { ClockSkewBanner } from './ClockSkewBanner'

function healthFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn<() => Promise<Response>>(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
}

const shifted = (seconds: number) => ({ status: 'ok', server_time: new Date(Date.now() + seconds * 1000).toISOString() })

function session(role: Role): Session {
  return {
    user: { id: 'u', email: 'u@example.test', displayName: 'U' },
    memberships: [{ organizationId: 'o', organizationName: 'Org', role }],
    csrfToken: 'csrf',
  }
}

const withSession = (role: Role, fetchFn: typeof fetch) => (
  <SessionProvider value={{ session: session(role), logout: () => {}, loggingOut: false }}>
    <ClockSkewBanner fetchFn={fetchFn} />
  </SessionProvider>
)

describe('parseServerTime', () => {
  it('przyjmuje ISO z serwera, odrzuca brak i śmieci', () => {
    expect(parseServerTime({ status: 'ok', server_time: '2026-11-07T15:15:44Z' })?.toISOString()).toBe(
      '2026-11-07T15:15:44.000Z',
    )
    expect(parseServerTime({ status: 'ok' })).toBeNull()
    expect(parseServerTime({ server_time: 'wczoraj' })).toBeNull()
    expect(parseServerTime(null)).toBeNull()
  })
})

describe('ClockSkewBanner', () => {
  it('rozjechany zegar: ostrzeżenie z wielkością różnicy, wskazówka dla administratora', async () => {
    render(withSession('OWNER', healthFetch(shifted(-(2 * 3600 + 13 * 60 + 30)))))
    expect(await screen.findByText(/różnią się o 2 h 13 min \(serwer spóźnia się względem/)).toBeTruthy()
    expect(screen.getByText(/to urządzenie ustawia czas automatycznie/)).toBeTruthy()
    expect(screen.getByText(/sudo solargraf status/)).toBeTruthy()
  })

  it('przeglądający widzi ostrzeżenie bez wskazówki dla administratora', async () => {
    render(withSession('VIEWER', healthFetch(shifted(630))))
    expect(await screen.findByText(/różnią się o 10 min \(serwer spieszy się względem/)).toBeTruthy()
    expect(screen.getByText(/to urządzenie ustawia czas automatycznie/)).toBeTruthy()
    expect(screen.queryByText(/sudo solargraf status/)).toBeNull()
  })

  it('zgodne zegary albo błąd sprawdzenia → brak banera', async () => {
    const ok = healthFetch(shifted(5))
    const { container, unmount } = render(<ClockSkewBanner fetchFn={ok} />)
    await waitFor(() => expect(ok).toHaveBeenCalled())
    expect(container.textContent).toBe('')
    unmount()
    const failing = healthFetch({ status: 'unavailable' }, 503)
    const second = render(<ClockSkewBanner fetchFn={failing} />)
    await waitFor(() => expect(failing).toHaveBeenCalled())
    expect(second.container.textContent).toBe('')
  })
})
