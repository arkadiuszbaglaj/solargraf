import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Role, Session } from '../api/auth'
import { bannerAlarms, parseSystemAlarm, parseSystemAlarms, type SystemAlarm } from '../api/systemAlarms'
import { SessionProvider } from '../auth/SessionContext'
import { SystemAlarmsPanel } from '../pages/SystemAlarmsPanel'
import { alarmsWord, SystemAlarmBanner } from './SystemAlarmBanner'

const RAW = {
  id: 'a1',
  code: 'DISK_FULL',
  severity: 'CRITICAL',
  message: 'Dysk zajęty powyżej 95%',
  opened_at: '2026-11-08T10:00:00Z',
  last_seen_at: '2026-11-08T11:00:00Z',
  closed_at: null,
  acknowledged_at: null,
  acknowledged_by: null,
}
const WARNING = { ...RAW, id: 'a2', code: 'MEMORY_HIGH', severity: 'WARNING', message: 'Pamięć RAM zajęta powyżej 90%' }

const body = (alarms: unknown[], stale = false) => ({
  alarms,
  worker_stale: stale,
  worker_stale_since: stale ? '2026-11-08T10:00:00Z' : null,
  server_time: '2026-11-08T12:00:00Z',
})

const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status })

function session(role: Role): Session {
  return {
    user: { id: 'u', email: 'u@example.test', displayName: 'U' },
    memberships: [{ organizationId: 'o', organizationName: 'Org', role }],
    csrfToken: 'csrf',
  }
}

const withSession = (role: Role, child: React.ReactNode) => (
  <SessionProvider value={{ session: session(role), logout: () => {}, loggingOut: false }}>{child}</SessionProvider>
)

const alarm = (over: Partial<SystemAlarm>): SystemAlarm => ({
  ...(parseSystemAlarm(RAW) as SystemAlarm),
  ...over,
})

describe('alarmy systemowe — dane (D68)', () => {
  it('waliduje odpowiedź, odrzuca nieznany priorytet i zły czas', () => {
    expect(parseSystemAlarms(body([RAW]))?.alarms[0]?.code).toBe('DISK_FULL')
    expect(parseSystemAlarms(body([{ ...RAW, severity: 'INFO' }]))).toBeNull()
    expect(parseSystemAlarms(body([{ ...RAW, opened_at: 'wczoraj' }]))).toBeNull()
    expect(parseSystemAlarms({ alarms: [] })).toBeNull()
  })

  it('baner: niepotwierdzone otwarte, krytyczne także po potwierdzeniu, bez zamkniętych', () => {
    const acked = '2026-11-08T11:30:00Z'
    const shown = bannerAlarms([
      alarm({ id: 'crit-acked', acknowledgedAt: acked }),
      alarm({ id: 'warn-acked', severity: 'WARNING', acknowledgedAt: acked }),
      alarm({ id: 'warn-open', severity: 'WARNING' }),
      alarm({ id: 'closed', closedAt: '2026-11-08T11:40:00Z' }),
    ])
    expect(shown.map((a) => a.id)).toEqual(['crit-acked', 'warn-open'])
  })

  it('odmiana liczby alarmów', () => {
    expect([1, 2, 5, 12, 22, 25].map(alarmsWord)).toEqual([
      '1 alarm',
      '2 alarmy',
      '5 alarmów',
      '12 alarmów',
      '22 alarmy',
      '25 alarmów',
    ])
  })
})

describe('SystemAlarmBanner', () => {
  it('OWNER widzi krytyczny alarm z linkiem do stanu serwera', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => json(200, body([RAW, WARNING])))
    render(withSession('OWNER', <SystemAlarmBanner fetchFn={fetchFn} />))
    const banner = await screen.findByRole('status')
    expect(banner.textContent).toContain('Serwer: 2 alarmy (krytyczne: 1)')
    expect(banner.textContent).toContain('Dysk zajęty powyżej 95% i inne.')
    expect(screen.getByRole('link', { name: 'Stan serwera' }).getAttribute('href')).toBe('/ustawienia/serwer')
  })

  it('brak odpowiedzi workera jest widoczny nawet bez alarmów', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => json(200, body([], true)))
    render(withSession('OWNER', <SystemAlarmBanner fetchFn={fetchFn} />))
    expect((await screen.findByRole('status')).textContent).toContain('Usługa obliczeń serwera nie odpowiada')
  })

  it('bez alarmów, po błędzie i dla innych ról — brak baneru i brak zapytań spoza OWNER', async () => {
    const empty = vi.fn<typeof fetch>(async () => json(200, body([])))
    const { unmount } = render(withSession('OWNER', <SystemAlarmBanner fetchFn={empty} />))
    await waitFor(() => expect(empty).toHaveBeenCalled())
    expect(screen.queryByRole('status')).toBeNull()
    unmount()
    const broken = vi.fn<typeof fetch>(async () => json(500, {}))
    render(withSession('OWNER', <SystemAlarmBanner fetchFn={broken} />))
    await waitFor(() => expect(broken).toHaveBeenCalled())
    expect(screen.queryByRole('status')).toBeNull()
    const admin = vi.fn<typeof fetch>()
    render(withSession('ADMIN', <SystemAlarmBanner fetchFn={admin} />))
    expect(admin).not.toHaveBeenCalled()
  })
})

describe('SystemAlarmsPanel', () => {
  it('lista z priorytetem tekstem i potwierdzanie z klawiatury z CSRF', async () => {
    const user = userEvent.setup()
    let acked = false
    let ackToken: string | null = null
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/acknowledge')) {
        acked = true
        ackToken = new Headers(init?.headers).get('X-CSRF-Token')
        return json(200, { ...WARNING, acknowledged_at: '2026-11-08T12:00:00Z', acknowledged_by: 'U' })
      }
      const warning = acked ? { ...WARNING, acknowledged_at: '2026-11-08T12:00:00Z', acknowledged_by: 'U' } : WARNING
      return json(200, body([RAW, warning, { ...RAW, id: 'old', closed_at: '2026-11-08T10:30:00Z' }]))
    })
    render(withSession('OWNER', <SystemAlarmsPanel fetchFn={fetchFn} timeZone="Europe/Warsaw" onExpired={() => {}} />))
    expect(await screen.findByText('Aktywne: 2')).toBeTruthy()
    expect(screen.getAllByText('Krytyczny')).toHaveLength(2)
    expect(screen.getByText('Ostrzeżenie')).toBeTruthy()
    expect(screen.getByText(/ustąpił/)).toBeTruthy()
    // 11:00 UTC = 12:00 w Warszawie
    expect(screen.getAllByText(/08\.11\.2026.*11:00|8 lis.*11:00/).length).toBeGreaterThan(0)

    const ack = screen.getByRole('button', { name: 'Potwierdź: Pamięć RAM zajęta powyżej 90%' })
    ack.focus()
    await user.keyboard('{Enter}')
    expect(
      await screen.findByText(
        (_, el) => el?.tagName === 'SPAN' && /^Potwierdzony .+ przez U$/.test(el.textContent ?? ''),
      ),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Potwierdź: Pamięć RAM zajęta powyżej 90%' })).toBeNull()
    expect(ackToken).toBe('csrf')
  })

  it('pusta lista i nieodpowiadający worker', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => json(200, body([], true)))
    render(withSession('OWNER', <SystemAlarmsPanel fetchFn={fetchFn} timeZone="Europe/Warsaw" onExpired={() => {}} />))
    expect(await screen.findByText('Brak alarmów serwera z ostatnich 7 dni.')).toBeTruthy()
    expect(screen.getByText(/alarmy serwera nie są aktualizowane/)).toBeTruthy()
  })

  it('wygasła sesja przekierowuje', async () => {
    const onExpired = vi.fn<() => void>()
    const fetchFn = vi.fn<typeof fetch>(async () => json(401, {}))
    render(withSession('OWNER', <SystemAlarmsPanel fetchFn={fetchFn} timeZone="Europe/Warsaw" onExpired={onExpired} />))
    await waitFor(() => expect(onExpired).toHaveBeenCalled())
  })
})
