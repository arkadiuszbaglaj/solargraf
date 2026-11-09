import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Session } from '../api/auth'
import { SessionProvider } from '../auth/SessionContext'
import { Sidebar } from '../layout/Sidebar'
import { ALARMS_PATH, routeFor } from '../Root'
import { parseAlarmPage } from '../api/alarms'
import { ALARMS_PAGE_SIZE, AlarmsPage } from './AlarmsPage'

const SITE = { id: '11111111-1111-1111-1111-111111111111', name: 'Dom', timezone: 'Europe/Warsaw' }

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

const ALARMS = [
  alarm({ id: 'a', code: 'AGENT_UNREACHABLE', severity: 'CRITICAL', title: 'Agent lokalny nie odpowiada', device_id: null }),
  alarm({ id: 'b', title: 'Dane nieaktualne: Falownik' }),
  alarm({
    id: 'c',
    title: 'Błąd odczytu: Licznik',
    code: 'DEVICE_READ_ERROR',
    closed_at: '2026-11-07T11:30:00Z',
    acknowledged_at: '2026-11-07T11:20:00Z',
    acknowledged_by: 'Arek',
  }),
]

const SUMMARY = { critical_active: 1, warning_active: 1, unacknowledged: 2, closed: 1 }

function page(alarms: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    alarms,
    can_acknowledge: false,
    can_view_history: false,
    days: 1,
    total: alarms.length,
    has_more: false,
    summary: SUMMARY,
    ...overrides,
  }
}

/** Serwer testowy: filtry z adresu, jak w API (stan i priorytet po stronie serwera). */
function alarmServer(all: Array<ReturnType<typeof alarm>>, extra: Record<string, unknown> = {}) {
  return vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input) => {
    const params = new URL(String(input), 'http://x').searchParams
    const state = params.get('state')
    const severity = params.get('severity')
    const shown = all.filter(
      (a) =>
        (severity === null || a.severity === severity) &&
        (state !== 'closed' || a.closed_at !== null) &&
        (state !== 'active' || a.closed_at === null) &&
        (state !== 'unacknowledged' || a.acknowledged_at === null),
    )
    const days = Number(params.get('days') ?? 1)
    return new Response(JSON.stringify(page(shown, { days, ...extra })), { status: 200 })
  })
}

const urls = (fetchFn: ReturnType<typeof alarmServer>) => fetchFn.mock.calls.map(([u]) => String(u))

const session = (role: Session['memberships'][number]['role']): Session => ({
  user: { id: 'u', email: 'u@example.test', displayName: 'Arek' },
  memberships: [{ organizationId: 'o', organizationName: 'Org', role }],
  csrfToken: 'csrf-test',
})

function links(role: 'OWNER' | 'ADMIN' | 'VIEWER'): Array<string | null> {
  const { unmount } = render(
    <SessionProvider value={{ session: session(role), logout: () => {}, loggingOut: false }}>
      <Sidebar open={false} id="menu" current="alarms" />
    </SessionProvider>,
  )
  const nav = screen.getByRole('navigation', { name: 'Główna nawigacja' })
  const names = within(nav).queryAllByRole('link').map((l) => l.textContent)
  expect(within(nav).getByRole('link', { name: 'Alarmy' }).getAttribute('aria-current')).toBe('page')
  unmount()
  return names
}

describe('AlarmsPage', () => {
  it('podsumowanie z serwera, filtry stanu i priorytetu wysyłane w zapytaniu', async () => {
    const fetchFn = alarmServer(ALARMS)
    render(<AlarmsPage site={SITE} origin="DEVICE" fetchFn={fetchFn} />)
    await screen.findByText('Agent lokalny nie odpowiada')
    expect(urls(fetchFn)[0]).toBe(`/api/sites/${SITE.id}/alarms?days=1&limit=${ALARMS_PAGE_SIZE}`)

    const summary = screen.getByRole('region', { name: 'Podsumowanie alarmów' })
    const value = (label: string) =>
      within(summary).getByRole('heading', { name: label }).closest('article')?.querySelector('p')?.textContent
    expect(value('Krytyczne aktywne')).toBe('1')
    expect(value('Ostrzeżenia aktywne')).toBe('1')
    expect(value('Niepotwierdzone')).toBe('2')
    expect(value('Zamknięte (24 h)')).toBe('1')
    expect(screen.getByText('Pokazane: 3 z 3')).toBeTruthy()
    // VIEWER (serwer nie pozwala na historię) — bez przełącznika okresu.
    expect(screen.queryByRole('group', { name: 'Okres' })).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Zamknięte' }))
    expect(await screen.findByText('Pokazane: 1 z 1')).toBeTruthy()
    expect(urls(fetchFn).at(-1)).toMatch(/[?&]state=closed(&|$)/)
    expect(screen.queryByText('Agent lokalny nie odpowiada')).toBeNull()
    expect(screen.getByText('Błąd odczytu: Licznik')).toBeTruthy()
    // Podsumowanie całego okresu nie zależy od filtrów.
    expect(value('Krytyczne aktywne')).toBe('1')

    await userEvent.click(screen.getByRole('button', { name: 'Aktywne' }))
    await userEvent.click(screen.getByRole('button', { name: 'Krytyczne' }))
    expect(screen.getByRole('button', { name: 'Krytyczne' }).getAttribute('aria-pressed')).toBe('true')
    expect(await screen.findByText('Pokazane: 1 z 1')).toBeTruthy()
    expect(urls(fetchFn).at(-1)).toMatch(/state=active&severity=CRITICAL$/)
    expect(screen.queryByText('Dane nieaktualne: Falownik')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Zamknięte' }))
    expect(await screen.findByText('Żaden alarm nie pasuje do filtrów.')).toBeTruthy()
  })

  it('właściciel: okres historii i „Pokaż więcej” dobiera kolejną stronę', async () => {
    const many = Array.from({ length: ALARMS_PAGE_SIZE + 2 }, (_, i) =>
      alarm({ id: `al-${i}`, title: `Alarm ${i}`, closed_at: '2026-11-01T10:00:00Z' }),
    )
    const fetchFn = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input) => {
      const params = new URL(String(input), 'http://x').searchParams
      const offset = Number(params.get('offset') ?? 0)
      const slice = many.slice(offset, offset + ALARMS_PAGE_SIZE)
      const body = page(slice, {
        can_view_history: true,
        can_acknowledge: true,
        days: Number(params.get('days')),
        total: many.length,
        has_more: offset + slice.length < many.length,
        summary: { ...SUMMARY, closed: many.length },
      })
      return new Response(JSON.stringify(body), { status: 200 })
    })
    render(<AlarmsPage site={SITE} origin="DEVICE" fetchFn={fetchFn} />)
    const period = await screen.findByRole('group', { name: 'Okres' })
    await userEvent.click(within(period).getByRole('button', { name: '30 dni' }))
    expect(await screen.findByText(`Pokazane: ${ALARMS_PAGE_SIZE} z ${many.length}`)).toBeTruthy()
    expect(urls(fetchFn).at(-1)).toBe(`/api/sites/${SITE.id}/alarms?days=30&limit=${ALARMS_PAGE_SIZE}`)
    expect(screen.getByRole('heading', { name: 'Zamknięte (30 dni)' })).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'Pokaż więcej' }))
    expect(await screen.findByText(`Pokazane: ${many.length} z ${many.length}`)).toBeTruthy()
    expect(urls(fetchFn)).toContain(`/api/sites/${SITE.id}/alarms?days=30&limit=${ALARMS_PAGE_SIZE}&offset=${ALARMS_PAGE_SIZE}`)
    expect(screen.getByText(`Alarm ${many.length - 1}`)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Pokaż więcej' })).toBeNull()

    // Zmiana filtra wraca do pierwszej strony.
    await userEvent.click(screen.getByRole('button', { name: 'Zamknięte' }))
    expect(urls(fetchFn).at(-1)).toBe(`/api/sites/${SITE.id}/alarms?days=30&limit=${ALARMS_PAGE_SIZE}&state=closed`)
  })

  it('parser strony: wymagane liczby, okres i podsumowanie', () => {
    expect(parseAlarmPage(page([alarm()]))?.summary.unacknowledged).toBe(2)
    expect(parseAlarmPage(page([], { days: 14 }))).toBeNull()
    expect(parseAlarmPage(page([], { total: -1 }))).toBeNull()
    expect(parseAlarmPage(page([], { summary: { ...SUMMARY, closed: null } }))).toBeNull()
    expect(parseAlarmPage({ alarms: [], can_acknowledge: true })).toBeNull()
  })

  it('pusta lista i tryb DEMO bez zapytań do serwera', async () => {
    render(<AlarmsPage site={SITE} origin="DEVICE" fetchFn={alarmServer([])} />)
    expect(await screen.findByText('Brak alarmów z ostatnich 24 h.')).toBeTruthy()

    const demoFetch = alarmServer([])
    render(<AlarmsPage site={SITE} origin="DEMO" fetchFn={demoFetch} />)
    expect(screen.getByText('Alarmy wymagają serwera — niedostępne w trybie DEMO.')).toBeTruthy()
    expect(demoFetch).not.toHaveBeenCalled()
  })

  it('adres /alarmy i menu: Raporty tylko dla OWNER i ADMIN', () => {
    expect(routeFor(ALARMS_PATH)).toBe('alarms')
    expect(routeFor(`${ALARMS_PATH}/`)).toBe('alarms')
    expect(links('ADMIN')).toContain('Raporty')
    expect(links('OWNER')).toContain('Raporty')
    expect(links('VIEWER')).not.toContain('Raporty')
  })
})
