import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Role, Session } from '../api/auth'
import { getSystemHealth, getSystemMetrics, parseSystemHealth, parseSystemMetrics } from '../api/system'
import { SessionProvider } from '../auth/SessionContext'
import { SettingsTabs } from '../layout/SettingsTabs'
import { Sidebar } from '../layout/Sidebar'
import { SERVER_HEALTH_PATH, UPDATES_PATH, routeFor } from '../Root'
import { ServerHealthPage } from './ServerHealthPage'
import { forecastText, toHistory } from './ServerHistory'

vi.mock('../components/HistoryChartView', () => ({
  HistoryChartView: ({ label }: { label: string }) => <div role="img" aria-label={label} />,
}))

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

const points = (values: Array<number | null>) =>
  values.map((v, i) => ({ t: `2026-11-07T${String(10 + i).padStart(2, '0')}:00:00Z`, avg: v, max: v === null ? null : v + 5 }))

const METRICS = {
  range: '24h',
  step_s: 300,
  start: '2026-11-06T12:00:30Z',
  end: '2026-11-07T12:00:30Z',
  series: {
    cpu_percent: { unit: '%', points: points([10, null, 30]) },
    memory_percent: { unit: '%', points: points([25, 26, null]) },
    disk_percent: { unit: '%', points: points([88, 88, 89]) },
    cpu_temp_c: { unit: '°C', points: points([null, null, null]) },
  },
  disk_forecast: { status: 'OK', full_at: '2026-12-23T12:00:30Z', growth_bytes_per_day: GIB },
  server_time: '2026-11-07T12:00:30Z',
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

// Stan aktualizacji bez nowej wersji (szczegóły — UpdatesPanel.test.tsx).
const UPDATES = {
  current_version: '0.1.0',
  configured: true,
  automatic: true,
  last_checked_at: '2026-11-07T11:00:00Z',
  last_success_at: '2026-11-07T11:00:00Z',
  last_error: null,
  next_check_at: '2026-11-14T11:00:00Z',
  available: null,
  dismissed: false,
}

const NO_ALARMS = { alarms: [], worker_stale: false, worker_stale_since: null, server_time: '2026-11-07T12:00:00Z' }

/** Atrapa API: odpowiedź zależna od adresu (stan, historia, alarmy albo aktualizacje). */
const routes = (
  health: [number, unknown],
  metrics: [number, unknown] = [200, METRICS],
  alarms: [number, unknown] = [health[0], NO_ALARMS],
) =>
  vi.fn<typeof fetch>((input) => {
    const url = String(input)
    const [status, body] = url.startsWith('/api/system/metrics')
      ? metrics
      : url.startsWith('/api/system/alarms')
        ? alarms
        : url.startsWith('/api/system/updates')
          ? [health[0], UPDATES]
          : health
    return Promise.resolve(json(status, body))
  })
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
    renderPage(routes([200, HEALTH]))
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
    renderPage(routes([200, HEALTH]))
    await screen.findByText('Ostrzeżenie')
    expect(dd('Temperatura procesora')).toBe('niedostępne')
    expect(dd('Niedobór napięcia')).toBe('niedostępne')
  })

  it('ostrzega o nieaktualnej ocenie', async () => {
    renderPage(routes([200, { ...HEALTH, level: 'CRITICAL', stale: true }]))
    expect(await screen.findByText(/Ocena jest nieaktualna/)).toBeTruthy()
    expect(screen.getByText('Krytyczny')).toBeTruthy()
  })

  it('403 — komunikat o braku uprawnień bez danych', async () => {
    renderPage(routes([403, {}]))
    expect(await screen.findByText(/tylko dla właściciela/)).toBeTruthy()
    expect(screen.queryByText('Procesor')).toBeNull()
  })

  it('401 — przekierowanie do logowania', async () => {
    const navigate = renderPage(routes([401, {}]))
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

describe('historia serwera', () => {
  it('parser przyjmuje serie z lukami i odrzuca nieznany zakres', () => {
    const parsed = parseSystemMetrics(METRICS)
    expect(parsed?.series.cpu_percent.points[1]?.avg).toBeNull()
    expect(parsed?.diskForecast.status).toBe('OK')
    expect(parseSystemMetrics({ ...METRICS, range: '1y' })).toBeNull()
    expect(parseSystemMetrics({ ...METRICS, disk_forecast: { status: 'MAYBE' } })).toBeNull()
    const { cpu_temp_c: _omit, ...series } = METRICS.series
    expect(parseSystemMetrics({ ...METRICS, series })).toBeNull()
  })

  it('wysyła wybrany zakres i rozróżnia 403', async () => {
    const fetchFn = fetchReturning(403)
    expect((await getSystemMetrics('7d', fetchFn)).kind).toBe('forbidden')
    expect(String(vi.mocked(fetchFn).mock.calls[0]?.[0])).toBe('/api/system/metrics?range=7d')
  })

  it('luka zostaje null, maksimum trafia do podpowiedzi', () => {
    const parsed = parseSystemMetrics(METRICS)
    if (!parsed) throw new Error('parse')
    const history = toHistory(parsed, 'cpu_percent', 'Europe/Warsaw')
    expect(history.points.map((p) => p.value)).toEqual([10, null, 30])
    expect(history.points[0]?.max).toBe(15)
    expect(history.cumulative).toBe(false)
  })

  it('tekst prognozy dla każdego statusu', () => {
    const now = new Date('2026-11-07T12:00:30Z')
    const ok = forecastText({ status: 'OK', fullAt: '2026-12-23T12:00:30Z', growthBytesPerDay: GIB }, now, 'UTC')
    expect(ok).toMatch(/^Szacunek: dysk zapełni się za ok\. 46 dni/)
    expect(ok).toMatch(/1,0 GiB na dobę/)
    const soon = forecastText({ status: 'OK', fullAt: '2026-11-07T20:00:00Z', growthBytesPerDay: GIB }, now, 'UTC')
    expect(soon).toMatch(/w ciągu doby/)
    expect(forecastText({ status: 'OVER_YEAR', fullAt: null, growthBytesPerDay: 1 }, now, 'UTC')).toMatch(/ponad rok/)
    expect(forecastText({ status: 'NOT_GROWING', fullAt: null, growthBytesPerDay: -5 }, now, 'UTC')).toMatch(
      /nie rośnie/,
    )
    expect(
      forecastText({ status: 'INSUFFICIENT_DATA', fullAt: null, growthBytesPerDay: null }, now, 'UTC'),
    ).toMatch(/co najmniej 3 dni/)
  })

  it('strona pokazuje wykresy, prognozę i brak temperatury', async () => {
    renderPage(routes([200, HEALTH]))
    expect(await screen.findByRole('img', { name: /Użycie procesora w %, ostatnie 24 h/ })).toBeTruthy()
    expect(screen.getByText(/za ok\. 46 dni/)).toBeTruthy()
    expect(screen.getByText('Parametr niedostępny na tym serwerze.')).toBeTruthy()
    expect(screen.queryByRole('img', { name: /Temperatura/ })).toBeNull()
  })

  it('przełącza zakres', async () => {
    const fetchFn = routes([200, HEALTH], [200, { ...METRICS, range: '7d' }])
    renderPage(fetchFn)
    const week = await screen.findByRole('button', { name: '7 dni' })
    expect(screen.getByRole('button', { name: '24 h' }).getAttribute('aria-pressed')).toBe('true')
    await userEvent.click(week)
    expect(week.getAttribute('aria-pressed')).toBe('true')
    expect(await screen.findByRole('img', { name: /Zajętość dysku w %, ostatnie 7 dni/ })).toBeTruthy()
    expect(fetchFn.mock.calls.map((c) => String(c[0]))).toContain('/api/system/metrics?range=7d')
  })

  it('błąd historii nie ukrywa stanu serwera', async () => {
    renderPage(routes([200, HEALTH], [500, {}]))
    expect(await screen.findByRole('button', { name: 'Spróbuj ponownie' })).toBeTruthy()
    expect(screen.getByText('Ostrzeżenie')).toBeTruthy()
  })
})

describe('trasa i menu', () => {
  it('rozpoznaje adres strony', () => {
    expect(routeFor(SERVER_HEALTH_PATH)).toBe('server')
    expect(routeFor(`${SERVER_HEALTH_PATH}/`)).toBe('server')
  })

  it('zakładki Ustawień: Stan serwera i Aktualizacje (D65)', () => {
    expect(routeFor(UPDATES_PATH)).toBe('updates')
    expect(routeFor(`${UPDATES_PATH}/`)).toBe('updates')
    render(<SettingsTabs current="updates" />)
    const nav = screen.getByRole('navigation', { name: 'Ustawienia' })
    const server = within(nav).getByRole('link', { name: 'Stan serwera' })
    const updates = within(nav).getByRole('link', { name: 'Aktualizacje' })
    expect(server.getAttribute('href')).toBe(SERVER_HEALTH_PATH)
    expect(server.getAttribute('aria-current')).toBeNull()
    expect(updates.getAttribute('href')).toBe(UPDATES_PATH)
    expect(updates.getAttribute('aria-current')).toBe('page')
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
