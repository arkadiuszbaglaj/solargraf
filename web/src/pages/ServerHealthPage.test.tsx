import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Role, Session } from '../api/auth'
import { getSystemHealth, parseSystemHealth } from '../api/system'
import { SessionProvider } from '../auth/SessionContext'
import { Sidebar } from '../layout/Sidebar'
import { SERVER_HEALTH_PATH, routeFor } from '../Root'
import { ServerHealthPage } from './ServerHealthPage'

const GIB = 1024 ** 3

// Wartości testowe — nie pochodzą z rzeczywistego hosta.
const HEALTH = {
  level: 'WARNING',
  reasons: [
    {
      code: 'DISK_HIGH',
      severity: 'WARNING',
      message: 'Dysk zajęty powyżej 85%.',
      since: '2026-11-07T10:00:00Z',
    },
  ],
  evaluated_at: '2026-11-07T12:00:00Z',
  stale: false,
  sampled_at: '2026-11-07T12:00:00Z',
  metrics: {
    cpu_percent: 12.5,
    cpu_count: 4,
    load_1m: 0.52,
    load_5m: 0.4,
    load_15m: 0.31,
    mem_used_bytes: 2 * GIB,
    mem_total_bytes: 8 * GIB,
    swap_used_bytes: 0,
    swap_total_bytes: 0,
    disk_used_bytes: 90 * GIB,
    disk_total_bytes: 100 * GIB,
    db_size_bytes: 1.5 * GIB,
    cpu_temp_c: null,
    uptime_s: 3 * 86400 + 4 * 3600,
    undervoltage_now: null,
  },
  percent: { memory: 25, swap: null, disk: 90 },
  components: [
    {
      component: 'api',
      name: 'API',
      state: 'UP',
      checked_at: '2026-11-07T12:00:00Z',
      last_ok_at: '2026-11-07T12:00:00Z',
    },
    {
      component: 'proxy',
      name: 'Serwer WWW (proxy)',
      state: 'DOWN',
      checked_at: '2026-11-07T12:00:00Z',
      last_ok_at: null,
    },
  ],
  app_version: '0.1.0',
  server_time: '2026-11-07T12:00:30Z',
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
const fetchReturning = (status: number, body: unknown = {}) =>
  vi.fn<typeof fetch>(() => Promise.resolve(json(status, body)))

function session(role: Role): Session {
  return {
    user: { id: 'u1', email: 'jan@example.pl', displayName: 'Jan' },
    memberships: [{ organizationId: 'o1', organizationName: 'Org', role }],
    csrfToken: 'csrf',
  }
}

function renderPage(fetchFn: typeof fetch, navigate = vi.fn<(url: string) => void>()) {
  render(<ServerHealthPage fetchFn={fetchFn} navigate={navigate} timeZone="Europe/Warsaw" />)
  return navigate
}

function dd(label: string): string {
  const term = screen.getByText(label, { selector: 'dt' })
  return term.nextElementSibling?.textContent ?? ''
}

describe('parseSystemHealth', () => {
  it('przyjmuje poprawną odpowiedź i zachowuje null', () => {
    const parsed = parseSystemHealth(HEALTH)
    expect(parsed?.level).toBe('WARNING')
    expect(parsed?.metrics.cpu_temp_c).toBeNull()
    expect(parsed?.components[1]?.lastOkAt).toBeNull()
  })

  it('brak klucza metryki to brak pomiaru, nie 0', () => {
    const { cpu_temp_c: _omit, ...metrics } = HEALTH.metrics
    expect(parseSystemHealth({ ...HEALTH, metrics })?.metrics.cpu_temp_c).toBeNull()
  })

  it('odrzuca nieznany poziom, zły typ metryki i zły czas', () => {
    expect(parseSystemHealth({ ...HEALTH, level: 'OK' })).toBeNull()
    expect(parseSystemHealth({ ...HEALTH, metrics: { ...HEALTH.metrics, cpu_percent: '12' } })).toBeNull()
    expect(parseSystemHealth({ ...HEALTH, server_time: 'wczoraj' })).toBeNull()
    expect(parseSystemHealth({ ...HEALTH, components: [{ component: 'api' }] })).toBeNull()
  })
})

describe('getSystemHealth', () => {
  it('rozróżnia 401, 403 i błąd', async () => {
    expect((await getSystemHealth(fetchReturning(401))).kind).toBe('anonymous')
    expect((await getSystemHealth(fetchReturning(403))).kind).toBe('forbidden')
    expect((await getSystemHealth(fetchReturning(500))).kind).toBe('error')
    expect((await getSystemHealth(fetchReturning(200, { level: 'STABLE' }))).kind).toBe('error')
  })
})

describe('ServerHealthPage', () => {
  it('pokazuje ocenę, przyczyny, metryki i składniki', async () => {
    renderPage(fetchReturning(200, HEALTH))
    expect(await screen.findByText('Ostrzeżenie')).toBeTruthy()
    expect(screen.getByText(/Dysk zajęty powyżej 85%/)).toBeTruthy()
    expect(dd('Rdzenie')).toBe('4')
    expect(dd('Zajętość')).toBe('90%')
    expect(dd('Swap')).toBe('wyłączony')
    expect(dd('Czas pracy hosta')).toBe('3 d 4 h')
    const proxy = screen.getByRole('row', { name: /Serwer WWW/ })
    expect(within(proxy).getByText('Niedostępny')).toBeTruthy()
  })

  it('brak pomiaru pokazuje jako „niedostępne”, nigdy 0', async () => {
    renderPage(fetchReturning(200, HEALTH))
    await screen.findByText('Ostrzeżenie')
    expect(dd('Temperatura procesora')).toBe('niedostępne')
    expect(dd('Niedobór napięcia')).toBe('niedostępne')
  })

  it('ostrzega o nieaktualnej ocenie', async () => {
    renderPage(fetchReturning(200, { ...HEALTH, level: 'CRITICAL', stale: true }))
    expect(await screen.findByText(/Ocena jest nieaktualna/)).toBeTruthy()
    expect(screen.getByText('Krytyczny')).toBeTruthy()
  })

  it('403 — komunikat o braku uprawnień bez danych', async () => {
    renderPage(fetchReturning(403))
    expect(await screen.findByText(/tylko dla właściciela/)).toBeTruthy()
    expect(screen.queryByText('Procesor')).toBeNull()
  })

  it('401 — przekierowanie do logowania', async () => {
    const navigate = renderPage(fetchReturning(401))
    await screen.findByRole('alert')
    expect(navigate).toHaveBeenCalledWith('/login?reason=expired')
  })

  it('błąd z możliwością ponowienia', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(500, {}))
      .mockResolvedValueOnce(json(200, HEALTH))
    renderPage(fetchFn)
    await userEvent.click(await screen.findByRole('button', { name: 'Spróbuj ponownie' }))
    expect(await screen.findByText('Ostrzeżenie')).toBeTruthy()
  })
})

describe('trasa i menu', () => {
  it('rozpoznaje adres strony', () => {
    expect(routeFor(SERVER_HEALTH_PATH)).toBe('server')
    expect(routeFor(`${SERVER_HEALTH_PATH}/`)).toBe('server')
  })

  it('link „Ustawienia” tylko dla roli OWNER', () => {
    const { unmount } = render(
      <SessionProvider value={{ session: session('OWNER'), logout: vi.fn<() => void>(), loggingOut: false }}>
        <Sidebar open={false} id="nav" current="server" />
      </SessionProvider>,
    )
    const link = screen.getByRole('link', { name: 'Ustawienia' })
    expect(link.getAttribute('href')).toBe(SERVER_HEALTH_PATH)
    expect(link.getAttribute('aria-current')).toBe('page')
    unmount()

    render(
      <SessionProvider value={{ session: session('ADMIN'), logout: vi.fn<() => void>(), loggingOut: false }}>
        <Sidebar open={false} id="nav" />
      </SessionProvider>,
    )
    expect(screen.queryByRole('link', { name: 'Ustawienia' })).toBeNull()
  })
})
