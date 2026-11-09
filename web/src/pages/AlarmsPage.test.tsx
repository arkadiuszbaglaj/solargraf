import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Session } from '../api/auth'
import { SessionProvider } from '../auth/SessionContext'
import { Sidebar } from '../layout/Sidebar'
import { ALARMS_PATH, routeFor } from '../Root'
import { AlarmsPage } from './AlarmsPage'

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

function fakeFetch(body: unknown) {
  return vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async () => new Response(JSON.stringify(body), { status: 200 }),
  )
}

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
  it('podsumowanie, lista do 200 alarmów i filtry stanu oraz priorytetu', async () => {
    const fetchFn = fakeFetch({ alarms: ALARMS, can_acknowledge: false })
    render(<AlarmsPage site={SITE} origin="DEVICE" fetchFn={fetchFn} />)
    await screen.findByText('Agent lokalny nie odpowiada')
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe(`/api/sites/${SITE.id}/alarms?limit=200`)

    const summary = screen.getByRole('region', { name: 'Podsumowanie alarmów' })
    const value = (label: string) =>
      within(summary).getByRole('heading', { name: label }).closest('article')?.querySelector('p')?.textContent
    expect(value('Krytyczne aktywne')).toBe('1')
    expect(value('Ostrzeżenia aktywne')).toBe('1')
    expect(value('Niepotwierdzone')).toBe('2')
    expect(value('Zamknięte (24 h)')).toBe('1')
    expect(screen.getByText('Pokazane: 3 z 3')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'Zamknięte' }))
    expect(screen.queryByText('Agent lokalny nie odpowiada')).toBeNull()
    expect(screen.getByText('Błąd odczytu: Licznik')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'Aktywne' }))
    await userEvent.click(screen.getByRole('button', { name: 'Krytyczne' }))
    expect(screen.getByRole('button', { name: 'Krytyczne' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('Pokazane: 1 z 3')).toBeTruthy()
    expect(screen.queryByText('Dane nieaktualne: Falownik')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Zamknięte' }))
    expect(screen.getByText('Żaden alarm nie pasuje do filtrów.')).toBeTruthy()
  })

  it('pusta lista i tryb DEMO bez zapytań do serwera', async () => {
    render(<AlarmsPage site={SITE} origin="DEVICE" fetchFn={fakeFetch({ alarms: [], can_acknowledge: true })} />)
    expect(await screen.findByText('Brak alarmów z ostatnich 24 h.')).toBeTruthy()

    const demoFetch = fakeFetch({})
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
