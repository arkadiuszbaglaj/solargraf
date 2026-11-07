import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { parseAlarmList } from '../api/alarms'
import type { Session } from '../api/auth'
import { SessionProvider } from '../auth/SessionContext'
import { SiteAlarmsPanel } from './SiteAlarmsPanel'

const SITE = '11111111-1111-1111-1111-111111111111'
const TZ = 'Europe/Warsaw'

function alarm(overrides: Record<string, unknown> = {}) {
  return {
    id: 'al-1',
    code: 'DEVICE_STALE',
    severity: 'WARNING',
    title: 'Dane nieaktualne: Falownik',
    details: null,
    last_ok_at: '2026-11-07T11:00:00Z',
    device_id: 'dev-1',
    opened_at: '2026-11-07T11:05:00Z',
    last_seen_at: '2026-11-07T11:59:00Z',
    closed_at: null,
    acknowledged_at: null,
    acknowledged_by: null,
    ...overrides,
  }
}

type Handler = (url: string, init?: RequestInit) => Response

function fakeFetch(handler: Handler) {
  return vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input, init) =>
    handler(String(input), init),
  )
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

const SESSION: Session = {
  user: { id: 'u', email: 'u@example.test', displayName: 'Arek' },
  memberships: [{ organizationId: 'o', organizationName: 'Org', role: 'OWNER' }],
  csrfToken: 'csrf-test',
}

const withSession = (fetchFn: typeof fetch) => (
  <SessionProvider value={{ session: SESSION, logout: () => {}, loggingOut: false }}>
    <SiteAlarmsPanel siteId={SITE} timeZone={TZ} fetchFn={fetchFn} />
  </SessionProvider>
)

describe('parseAlarmList', () => {
  it('przyjmuje odpowiedź API i odrzuca nieznany priorytet albo brak pól', () => {
    expect(parseAlarmList({ alarms: [alarm()], can_acknowledge: false })?.alarms[0]?.openedAt).toBe(
      '2026-11-07T11:05:00Z',
    )
    expect(parseAlarmList({ alarms: [alarm({ severity: 'PANIC' })], can_acknowledge: false })).toBeNull()
    expect(parseAlarmList({ alarms: [alarm({ closed_at: 'wczoraj' })], can_acknowledge: false })).toBeNull()
    expect(parseAlarmList({ alarms: [] })).toBeNull()
  })
})

describe('SiteAlarmsPanel', () => {
  it('lista z priorytetem tekstem, czasem w strefie instalacji i stanem', async () => {
    const fetchFn = fakeFetch(() =>
      json({
        alarms: [
          alarm({ id: 'a', code: 'AGENT_UNREACHABLE', severity: 'CRITICAL', title: 'Agent lokalny nie odpowiada', device_id: null, last_ok_at: null }),
          alarm({ id: 'b', closed_at: '2026-11-07T11:30:00Z', acknowledged_at: '2026-11-07T11:20:00Z', acknowledged_by: 'Arek' }),
        ],
        can_acknowledge: false,
      }),
    )
    render(<SiteAlarmsPanel siteId={SITE} timeZone={TZ} fetchFn={fetchFn as unknown as typeof fetch} />)
    const critical = (await screen.findByText('Agent lokalny nie odpowiada')).closest('li')?.textContent ?? ''
    expect(critical).toContain('Krytyczny')
    expect(critical).toContain('otwarty 07.11.2026, 12:05') // UTC+1 w listopadzie
    expect(critical).toContain('aktywny')
    expect(critical).toContain('Ostatni heartbeat: nigdy')
    const closed = screen.getByText('Dane nieaktualne: Falownik').closest('li')?.textContent ?? ''
    expect(closed).toContain('zamknięty 07.11.2026, 12:30')
    expect(closed).toContain('Ostatni udany odczyt: 07.11.2026, 12:00')
    expect(closed).toContain('Potwierdzony 07.11.2026, 12:20 przez Arek')
    expect(screen.getByText('Aktywne: 1')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Potwierdź/ })).toBeNull() // VIEWER
    expect(fetchFn.mock.calls[0]?.[0]).toBe(`/api/sites/${SITE}/alarms`)
  })

  it('OWNER potwierdza alarm z tokenem CSRF i odświeża listę', async () => {
    let acknowledged = false
    const fetchFn = fakeFetch((_url, init) => {
      if (init?.method === 'POST') {
        acknowledged = true
        return json(alarm({ acknowledged_at: '2026-11-07T11:58:00Z', acknowledged_by: 'Arek' }))
      }
      return json({
        alarms: [acknowledged ? alarm({ acknowledged_at: '2026-11-07T11:58:00Z', acknowledged_by: 'Arek' }) : alarm()],
        can_acknowledge: true,
      })
    })
    render(withSession(fetchFn as unknown as typeof fetch))
    await userEvent.click(await screen.findByRole('button', { name: 'Potwierdź: Dane nieaktualne: Falownik' }))
    const item = await screen.findByText(
      (_text, el) => el?.tagName === 'LI' && (el.textContent ?? '').includes('Potwierdzony 07.11.2026, 12:58 przez Arek'),
    )
    expect(item).toBeTruthy()
    const post = fetchFn.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(post?.[0]).toBe(`/api/sites/${SITE}/alarms/al-1/acknowledge`)
    expect(new Headers(post?.[1]?.headers).get('X-CSRF-Token')).toBe('csrf-test')
    expect(screen.queryByRole('button', { name: /Potwierdź/ })).toBeNull()
  })

  it('odmowa potwierdzenia: komunikat, alarm zostaje niepotwierdzony', async () => {
    const fetchFn = fakeFetch((_url, init) =>
      init?.method === 'POST' ? json({ detail: 'Brak uprawnień.' }, 403) : json({ alarms: [alarm()], can_acknowledge: true }),
    )
    render(withSession(fetchFn as unknown as typeof fetch))
    await userEvent.click(await screen.findByRole('button', { name: /Potwierdź/ }))
    expect((await screen.findByRole('alert')).textContent).toBe('Nie masz uprawnień do potwierdzania alarmów.')
    expect(screen.getByRole('button', { name: /Potwierdź/ })).toBeTruthy()
  })

  it('brak alarmów i błąd pobrania', async () => {
    const { unmount } = render(
      <SiteAlarmsPanel siteId={SITE} timeZone={TZ} fetchFn={fakeFetch(() => json({ alarms: [], can_acknowledge: true })) as unknown as typeof fetch} />,
    )
    expect(await screen.findByText('Brak alarmów z ostatnich 24 h.')).toBeTruthy()
    unmount()
    render(<SiteAlarmsPanel siteId={SITE} timeZone={TZ} fetchFn={fakeFetch(() => json({}, 500)) as unknown as typeof fetch} />)
    const panel = (await screen.findByRole('button', { name: /Spróbuj ponownie/ })).closest('section')
    expect(within(panel as HTMLElement).getByText(/Nie udało się/)).toBeTruthy()
  })
})
