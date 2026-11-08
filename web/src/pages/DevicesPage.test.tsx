import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../api/auth'
import type { ApiProfile, ConnectionForm } from '../api/devices'
import { parseDevice, parseProfile, validateConnection } from '../api/devices'
import type { LiveEventSource, LiveSourceFactory } from '../api/live'
import { SessionProvider } from '../auth/SessionContext'
import { devicesSiteId, devicesTabIds, routeFor } from '../Root'
import { devicesUrl } from '../paths'
import { DevicesPage } from './DevicesPage'

// ECharts wymaga przeglądarki (wymiary, ResizeObserver); opcje wykresu testujemy osobno.
vi.mock('../components/HistoryChartView', () => ({
  HistoryChartView: ({ label }: { label: string }) => <div role="img" aria-label={label} />,
}))

const SITE_ID = '0b5c3a52-6f0e-4d0b-9a77-6a1f2c3d4e5f'
const DEVICE_UUID = '1c6d4b63-7f1f-4e1c-8b88-7b2f3d4e5f60'
const NOW = new Date('2026-11-07T12:00:00Z')
const SITE = { id: SITE_ID, organization_id: 'o1', name: 'Dom', timezone: 'Europe/Warsaw', role: 'OWNER' }
const CONNECTION = {
  id: 'c1',
  name: 'Logger',
  transport: 'MODBUS_TCP',
  host: '192.168.1.50',
  port: 502,
  unit_id: 1,
  poll_interval_seconds: null,
  timeout_seconds: null,
}
const DEVICE = {
  id: 'd1',
  parent_device_id: null,
  name: 'Falownik dach',
  kind: 'INVERTER',
  manufacturer: 'SolarGraf',
  model: null,
  enabled: true,
  status: 'STALE',
  last_success_at: '2026-11-07T11:05:00Z',
  support_level: 'EXPERIMENTAL',
  details: {
    firmware_version: null,
    serial_number: null,
    profile_id: 'simulated.hybrid-inverter',
    profile_version: '0.1.0',
    connection: CONNECTION,
  },
  metrics: [
    { key: 'pv_energy_total', channel: null, name: 'Energia PV', unit: 'Wh', cumulative: true },
    { key: 'pv_string_voltage', channel: 1, name: 'Napięcie stringu PV', unit: 'V', cumulative: false },
    { key: 'pv_power', channel: null, name: 'Moc PV', unit: 'W', cumulative: false },
  ],
}
const METER = {
  ...DEVICE,
  id: 'd2',
  name: 'Licznik sieci',
  kind: 'METER',
  manufacturer: 'Eastron',
  model: 'SDM630',
  status: 'OK',
  support_level: 'COMMUNITY',
  details: {
    ...DEVICE.details,
    firmware_version: '1.0.8',
    serial_number: 'SN-1',
    profile_id: 'eastron.sdm630',
    connection: { ...CONNECTION, host: '192.168.1.52' },
  },
  metrics: [{ key: 'grid_power', channel: null, name: 'Moc sieci', unit: 'W', cumulative: false }],
}
const PROFILE = {
  id: 'simulated.hybrid-inverter',
  version: '0.1.0',
  name: 'Falownik hybrydowy',
  manufacturer: 'Symulator',
  device_kind: 'INVERTER',
  origin: 'SIMULATED',
  support_level: 'EXPERIMENTAL',
  models: [],
  transports: ['MODBUS_TCP'],
  poll_interval_seconds: 10,
}

function history(values: Array<number | null>, origins = ['SIMULATED']) {
  return {
    metric: 'pv_power',
    channel: null,
    unit: 'W',
    cumulative: false,
    resolution: '5m',
    timezone: 'Europe/Warsaw',
    origins,
    points: values.map((value, i) => ({
      t: new Date(Date.parse('2026-11-06T23:00:00Z') + i * 300_000).toISOString(),
      value,
      min: value,
      max: value,
      coverage: value === null ? 0 : 1,
    })),
  }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

function session(role: 'OWNER' | 'ADMIN' | 'VIEWER'): Session {
  return {
    user: { id: 'u1', email: 'jan@example.pl', displayName: 'Jan' },
    memberships: [{ organizationId: 'o1', organizationName: 'Org', role }],
    csrfToken: 'csrf',
  }
}

type Route = (url: string, init?: RequestInit) => Response | undefined

function server(route: Route = () => undefined, role: 'OWNER' | 'VIEWER' = 'OWNER', devices: object[] = [DEVICE]) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    const custom = route(url, init)
    if (custom) return custom
    if (url === `/api/sites/${SITE_ID}`) return json(200, { ...SITE, role })
    if (url === `/api/sites/${SITE_ID}/devices`) {
      return json(
        200,
        devices.map((d) => (role === 'VIEWER' ? { ...d, details: null } : d)),
      )
    }
    if (url === '/api/profiles') return json(200, [PROFILE])
    if (url.includes('/history?')) return json(200, history([1000, null, 1500]))
    return json(404, { detail: 'x' })
  })
}

class FakeSource implements LiveEventSource {
  readyState = 1
  private listeners = new Map<string, (event: MessageEvent<string>) => void>()

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, listener)
  }

  close(): void {
    this.readyState = 2
  }

  emit(type: string, data: unknown): void {
    act(() => this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(data) })))
  }
}

function reading(metric: string, channel: number | null, value: number | null, secondsAgo: number, origin = 'DEVICE') {
  return {
    device_id: 'd1',
    metric,
    channel,
    value,
    quality: value === null ? 'MISSING' : 'GOOD',
    origin,
    received_at: new Date(NOW.getTime() - secondsAgo * 1000).toISOString(),
  }
}

function renderPage(
  fetchFn: typeof fetch,
  s: Session = session('OWNER'),
  navigate = vi.fn<(u: string) => void>(),
  props: { initialDeviceId?: string; origin?: 'DEVICE' | 'DEMO' } = {},
) {
  const sources: FakeSource[] = []
  const liveFactory: LiveSourceFactory = () => {
    const source = new FakeSource()
    sources.push(source)
    return source
  }
  render(
    <SessionProvider value={{ session: s, logout: () => undefined, loggingOut: false }}>
      <DevicesPage siteId={SITE_ID} now={NOW} fetchFn={fetchFn} navigate={navigate} liveFactory={liveFactory} {...props} />
    </SessionProvider>,
  )
  return { navigate, sources }
}

afterEach(() => window.history.replaceState(null, '', '/'))

const PROFILES = [parseProfile(PROFILE)].filter((p): p is ApiProfile => p !== null)
const FORM: ConnectionForm = {
  name: 'Logger',
  host: '192.168.1.50',
  port: '502',
  unitId: '1',
  pollIntervalSeconds: '',
  deviceName: 'Falownik',
  profile: 'simulated.hybrid-inverter@0.1.0',
}

describe('api/devices', () => {
  it('waliduje urządzenie i profil', () => {
    expect(parseDevice(DEVICE)?.details?.connection.host).toBe('192.168.1.50')
    expect(parseDevice({ ...DEVICE, details: null })?.details).toBeNull()
    expect(parseDevice({ ...DEVICE, status: 'ONLINE' })).toBeNull()
    expect(parseDevice({ ...DEVICE, last_success_at: 5 })).toBeNull()
    expect(parseProfile(PROFILE)).toMatchObject({ simulated: true, modbusTcp: true, pollIntervalSeconds: 10 })
    expect(parseProfile({ ...PROFILE, origin: 'X' })).toBeNull()
    // Poziom wsparcia (D58): znany albo null — nieznana wartość nie psuje odpowiedzi.
    expect(parseDevice(DEVICE)?.supportLevel).toBe('EXPERIMENTAL')
    expect(parseDevice({ ...DEVICE, support_level: null })?.supportLevel).toBeNull()
    expect(parseDevice({ ...DEVICE, support_level: 'GOLD' })?.supportLevel).toBeNull()
    expect(parseProfile(PROFILE)?.supportLevel).toBe('EXPERIMENTAL')
  })

  it('firmware i numer seryjny: tekst albo null; inny typ odrzuca odpowiedź', () => {
    expect(parseDevice(METER)?.details).toMatchObject({ firmwareVersion: '1.0.8', serialNumber: 'SN-1' })
    expect(parseDevice(DEVICE)?.details).toMatchObject({ firmwareVersion: null, serialNumber: null })
    expect(parseDevice({ ...DEVICE, details: { ...DEVICE.details, firmware_version: 7 } })).toBeNull()
  })

  it('formularz: poprawne dane i pusty interwał = z profilu', () => {
    const { errors, input } = validateConnection(FORM, PROFILES)
    expect(errors).toEqual({})
    expect(input).toEqual({
      name: 'Logger',
      host: '192.168.1.50',
      port: 502,
      unitId: 1,
      pollIntervalSeconds: null,
      deviceName: 'Falownik',
      profileId: 'simulated.hybrid-inverter',
      profileVersion: '0.1.0',
    })
    expect(validateConnection({ ...FORM, host: 'inverter.lan' }, PROFILES).input?.host).toBe('inverter.lan')
  })

  it.each(['8.8.8.8', '127.0.0.1', '169.254.169.254', '172.32.0.1', 'localhost', '2130706433', 'a_b'])(
    'formularz odrzuca adres %s',
    (host) => {
      expect(validateConnection({ ...FORM, host }, PROFILES).errors.host).toBeDefined()
    },
  )

  it('formularz odrzuca złe liczby, puste nazwy i brak profilu', () => {
    const { errors, input } = validateConnection(
      { ...FORM, port: '0', unitId: '256', pollIntervalSeconds: '0', name: ' ', deviceName: '', profile: '' },
      PROFILES,
    )
    expect(input).toBeNull()
    expect(Object.keys(errors).toSorted()).toEqual(
      ['deviceName', 'name', 'pollIntervalSeconds', 'port', 'profile', 'unitId'].toSorted(),
    )
  })
})

describe('routing', () => {
  it('rozpoznaje zakładkę i dawny adres urządzeń instalacji', () => {
    expect(routeFor('/urzadzenia')).toBe('devices')
    expect(routeFor('/urzadzenia/')).toBe('devices')
    expect(routeFor(`/instalacje/${SITE_ID}/urzadzenia`)).toBe('devices')
    expect(devicesSiteId(`/instalacje/${SITE_ID}/urzadzenia/`)).toBe(SITE_ID)
    expect(routeFor('/instalacje/../urzadzenia')).toBe('app')
    expect(devicesSiteId('/instalacje/x/urzadzenia')).toBeNull()
  })

  it('instalacja i urządzenie z adresu; wartości spoza UUID pomijane', () => {
    expect(devicesTabIds('/urzadzenia', `?instalacja=${SITE_ID}&urzadzenie=${DEVICE_UUID}`)).toEqual({
      siteId: SITE_ID,
      deviceId: DEVICE_UUID,
    })
    expect(devicesTabIds('/urzadzenia', '?instalacja=../x&urzadzenie=1')).toEqual({ siteId: '', deviceId: '' })
    expect(devicesTabIds(`/instalacje/${SITE_ID}/urzadzenia`, '')).toEqual({ siteId: SITE_ID, deviceId: '' })
    expect(devicesUrl(SITE_ID, DEVICE_UUID)).toBe(`/urzadzenia?instalacja=${SITE_ID}&urzadzenie=${DEVICE_UUID}`)
  })
})

const span = (p: URLSearchParams) => Date.parse(p.get('to') ?? '') - Date.parse(p.get('from') ?? '')

async function rowOf(name: string) {
  const row = (await screen.findByRole('button', { name })).closest('tr')
  if (!row) throw new Error('brak wiersza')
  return within(row)
}

describe('DevicesPage', () => {
  it('właściciel widzi status słowem, profil SIMULATED i adres', async () => {
    renderPage(server())
    const cells = await rowOf('Falownik dach')
    expect(cells.getByText('Dane nieaktualne')).toBeTruthy()
    expect(cells.getByText('Falownik')).toBeTruthy()
    expect(cells.getByText(/SIMULATED/)).toBeTruthy()
    expect(cells.getByText('192.168.1.50:502')).toBeTruthy()
    expect(cells.getByText('07.11.2026, 12:05')).toBeTruthy()
    expect(cells.getByText('55 min temu')).toBeTruthy()
    const level = cells.getByText('Eksperymentalny')
    expect(level.getAttribute('title')).toContain('Nie polegaj na odczytach')
    expect(screen.getByRole('button', { name: 'Dodaj urządzenie' })).toBeTruthy()
  })

  it('podgląd (VIEWER) nie widzi szczegółów ani formularza', async () => {
    renderPage(server(undefined, 'VIEWER'), session('VIEWER'))
    await rowOf('Falownik dach')
    expect(screen.queryByText('192.168.1.50:502')).toBeNull()
    expect(screen.queryByRole('button', { name: /Wyłącz/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Dodaj urządzenie' })).toBeNull()
    expect(screen.queryByText('Wersja firmware')).toBeNull()
    expect(screen.getAllByText('Eksperymentalny').length).toBeGreaterThan(0) // poziom wsparcia widzi każda rola
  })

  it('nieznana lub cudza instalacja', async () => {
    renderPage(server((url) => (url === `/api/sites/${SITE_ID}` ? json(404, { detail: 'x' }) : undefined)))
    expect(await screen.findByText('Nie znaleziono instalacji.')).toBeTruthy()
  })

  it('wygasła sesja przekierowuje do logowania', async () => {
    const { navigate } = renderPage(server((url) => (url === `/api/sites/${SITE_ID}` ? json(401, {}) : undefined)))
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/login?reason=expired'))
  })

  it('tryb DEMO: lista wymaga serwera, bez zapytań', () => {
    const fetchFn = server()
    renderPage(fetchFn, session('OWNER'), undefined, { origin: 'DEMO' })
    expect(screen.getByText(/niedostępna w trybie DEMO/)).toBeTruthy()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('kafle liczą statusy i filtrują; wyszukiwarka i typ zawężają listę', async () => {
    const user = userEvent.setup()
    renderPage(server(undefined, 'OWNER', [DEVICE, METER]))
    await rowOf('Licznik sieci')
    const tiles = within(screen.getByRole('group', { name: 'Liczba urządzeń według statusu' }))
    expect(tiles.getByRole('button', { name: 'Wszystkie: 2' })).toBeTruthy()
    expect(tiles.queryByRole('button', { name: /Wyłączone/ })).toBeNull() // brak wyłączonych — bez kafla
    await user.click(tiles.getByRole('button', { name: 'Wymaga uwagi: 1' }))
    expect(tiles.getByRole('button', { name: 'Wymaga uwagi: 1' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('button', { name: 'Licznik sieci' })).toBeNull()
    expect(screen.getByText('Wyświetlono 1 z 2 urządzeń.')).toBeTruthy()
    await user.click(tiles.getByRole('button', { name: 'Wszystkie: 2' }))

    await user.type(screen.getByLabelText('Szukaj urządzenia'), 'sdm630')
    expect(screen.queryByRole('button', { name: 'Falownik dach' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Licznik sieci' })).toBeTruthy()
    await user.clear(screen.getByLabelText('Szukaj urządzenia'))

    await user.selectOptions(screen.getByLabelText('Typ'), 'INVERTER')
    expect(screen.queryByRole('button', { name: 'Licznik sieci' })).toBeNull()
    await user.selectOptions(screen.getByLabelText('Status'), 'OK')
    expect(screen.getByText('Żadne urządzenie nie pasuje do filtrów.')).toBeTruthy()
  })

  it('wybór urządzenia pokazuje jego szczegóły i zapisuje wybór w adresie', async () => {
    const user = userEvent.setup()
    renderPage(server(undefined, 'OWNER', [DEVICE, METER]))
    // Domyślnie pierwsze urządzenie listy.
    expect(await screen.findByRole('heading', { level: 2, name: 'Falownik dach' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Licznik sieci' }))
    expect(screen.getByRole('heading', { level: 2, name: 'Licznik sieci' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Licznik sieci' }).getAttribute('aria-current')).toBe('true')
    expect(window.location.search).toBe(`?instalacja=${SITE_ID}&urzadzenie=d2`)
    expect(screen.getByText('1.0.8')).toBeTruthy()
    expect(screen.getByText('SN-1')).toBeTruthy()
  })

  it('wybór urządzenia z adresu', async () => {
    renderPage(server(undefined, 'OWNER', [DEVICE, METER]), session('OWNER'), undefined, { initialDeviceId: 'd2' })
    expect(await screen.findByRole('heading', { level: 2, name: 'Licznik sieci' })).toBeTruthy()
  })

  it('bieżące wartości: jednostka i wiek, brak odczytu to „—”, nieaktualne oznaczone', async () => {
    const { sources } = renderPage(server())
    await screen.findByRole('heading', { level: 2, name: 'Falownik dach' })
    expect(screen.getByText('niedostępna')).toBeTruthy() // firmware
    expect(screen.getByText('niedostępny')).toBeTruthy() // numer seryjny
    const [source] = sources
    if (!source) throw new Error('brak strumienia')
    source.emit('snapshot', {
      site_id: SITE_ID,
      timezone: 'Europe/Warsaw',
      server_time: NOW.toISOString(),
      devices: [
        {
          id: 'd1',
          name: DEVICE.name,
          kind: DEVICE.kind,
          enabled: true,
          freshness_threshold_seconds: 60,
          metrics: DEVICE.metrics,
        },
      ],
      readings: [
        reading('pv_power', null, 2500, 12, 'SIMULATED'),
        reading('pv_string_voltage', 1, 350.5, 120),
        reading('pv_energy_total', null, null, 5),
      ],
    })
    const table = within(screen.getByRole('table', { name: 'Bieżące wartości urządzenia Falownik dach' }))
    const row = (name: string) => {
      const tr = table.getByRole('rowheader', { name }).closest('tr')
      if (!tr) throw new Error('brak wiersza')
      return within(tr)
    }
    expect(row('Moc PV').getByText('2,50 kW')).toBeTruthy()
    expect(row('Moc PV').getByText('12 s temu')).toBeTruthy()
    expect(row('Napięcie stringu PV 1').getByText('350,5 V')).toBeTruthy()
    expect(row('Napięcie stringu PV 1').getByText('2 min temu · nieaktualne')).toBeTruthy()
    expect(row('Energia PV').getByText('—')).toBeTruthy()
    expect(screen.getAllByText('SIMULATED').length).toBeGreaterThan(0)
  })

  it('wykres: domyślnie moc za 24 h, zmiana zakresu pobiera 7 dni', async () => {
    const user = userEvent.setup()
    const fetchFn = server()
    renderPage(fetchFn)
    expect(await screen.findByRole('img', { name: 'Wykres: Moc PV — 24 h' })).toBeTruthy()
    const historyCalls = () => fetchFn.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/history?'))
    const first = new URL(historyCalls()[0] ?? '', 'http://x').searchParams
    expect(first.get('metric')).toBe('pv_power')
    expect(span(first)).toBe(86_400_000)
    // Liczniki energii nie trafiają na wykres liniowy.
    const options = within(screen.getByLabelText('Parametr'))
      .getAllByRole('option')
      .map((o) => o.textContent)
    expect(options).toEqual(['Moc PV', 'Napięcie stringu PV 1'])
    await user.click(screen.getByRole('button', { name: '7 dni' }))
    expect(await screen.findByRole('img', { name: 'Wykres: Moc PV — 7 dni' })).toBeTruthy()
    expect(span(new URL(historyCalls().at(-1) ?? '', 'http://x').searchParams)).toBe(7 * 86_400_000)
    expect(screen.getByRole('link', { name: 'Pełna historia' }).getAttribute('href')).toBe(
      `/instalacje/${SITE_ID}/urzadzenia/d1/historia`,
    )
  })

  it('wykres bez danych w zakresie — stan pusty, nie zero', async () => {
    renderPage(server((url) => (url.includes('/history?') ? json(200, history([null, null], [])) : undefined)))
    expect(await screen.findByText('Brak pomiarów w tym zakresie.')).toBeTruthy()
  })

  it('dodaje urządzenie z tokenem CSRF i odświeża listę', async () => {
    const user = userEvent.setup()
    const posted: unknown[] = []
    const csrf: (string | null)[] = []
    const fetchFn = server((url, init) => {
      if (url === `/api/sites/${SITE_ID}/connections` && init?.method === 'POST') {
        csrf.push(new Headers(init.headers).get('X-CSRF-Token'))
        posted.push(JSON.parse(String(init.body)))
        return json(201, { connection: CONNECTION, device: { ...DEVICE, name: 'Nowy' } })
      }
      return undefined
    })
    renderPage(fetchFn)
    await user.click(await screen.findByRole('button', { name: 'Dodaj urządzenie' }))
    await user.selectOptions(await screen.findByLabelText('Profil urządzenia'), 'simulated.hybrid-inverter@0.1.0')
    expect(screen.getByText(/profil symulatora do testów/)).toBeTruthy()
    expect(screen.getByText(/Wsparcie profilu: Eksperymentalny\. Profil niepełny/)).toBeTruthy()
    await user.type(screen.getByLabelText('Nazwa urządzenia'), 'Nowy')
    await user.type(screen.getByLabelText('Nazwa połączenia'), 'Logger')
    await user.type(screen.getByLabelText('Adres w sieci lokalnej'), '192.168.1.60')
    await user.click(screen.getByRole('button', { name: 'Dodaj urządzenie' }))
    expect(await screen.findByText(/Dodano „Nowy”/)).toBeTruthy()
    expect(csrf).toEqual(['csrf'])
    expect(posted).toEqual([
      {
        name: 'Logger',
        host: '192.168.1.60',
        port: 502,
        unit_id: 1,
        poll_interval_seconds: null,
        device: { name: 'Nowy', profile_id: 'simulated.hybrid-inverter', profile_version: '0.1.0' },
      },
    ])
  })

  it('kreator: test komunikacji przed zapisem; zmiana adresu unieważnia wynik', async () => {
    const user = userEvent.setup()
    const tests: unknown[] = []
    const fetchFn = server((url, init) => {
      if (url === `/api/sites/${SITE_ID}/connection-tests` && init?.method === 'POST') {
        tests.push(JSON.parse(String(init.body)))
        return json(202, {
          id: 't1',
          state: 'DONE',
          result: 'OK',
          error_code: null,
          origin: 'SIMULATED',
          readings: [{ metric: 'pv_power', channel: null, name: 'Moc PV', unit: 'W', value: 1500, quality: 'GOOD' }],
        })
      }
      return undefined
    })
    renderPage(fetchFn)
    await user.click(await screen.findByRole('button', { name: 'Dodaj urządzenie' }))
    expect(await screen.findByRole('group', { name: '1. Profil i adres' })).toBeTruthy()
    expect(screen.getByRole('group', { name: '2. Test komunikacji' })).toBeTruthy()
    expect(screen.getByRole('group', { name: '3. Nazwy i zapis' })).toBeTruthy()

    // Bez profilu i adresu test nie jest zlecany; nazwy nie są wtedy wymagane.
    await user.click(screen.getByRole('button', { name: 'Testuj połączenie' }))
    expect(tests).toEqual([])
    expect(screen.getByLabelText('Adres w sieci lokalnej').getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByLabelText('Nazwa urządzenia').getAttribute('aria-invalid')).toBeNull()

    await user.selectOptions(screen.getByLabelText('Profil urządzenia'), 'simulated.hybrid-inverter@0.1.0')
    await user.type(screen.getByLabelText('Adres w sieci lokalnej'), '192.168.1.60')
    await user.click(screen.getByRole('button', { name: 'Testuj połączenie' }))
    expect(await screen.findByText(/Połączenie działa — odczytano wszystkie parametry/)).toBeTruthy()
    expect(screen.getByRole('row', { name: /Moc PV/ }).textContent).toContain('1,50 kW')
    expect(tests).toEqual([
      { host: '192.168.1.60', port: 502, unit_id: 1, profile_id: 'simulated.hybrid-inverter', profile_version: '0.1.0' },
    ])

    await user.type(screen.getByLabelText('Adres w sieci lokalnej'), '1')
    expect(screen.queryByText(/Połączenie działa/)).toBeNull()
  })

  it('błąd walidacji w przeglądarce nie wysyła żądania; komunikat serwera jest pokazany', async () => {
    const user = userEvent.setup()
    const fetchFn = server((url, init) =>
      url.endsWith('/connections') && init?.method === 'POST'
        ? json(409, { detail: 'Brak jednoznacznego agenta lokalnego.' })
        : undefined,
    )
    renderPage(fetchFn)
    await user.click(await screen.findByRole('button', { name: 'Dodaj urządzenie' }))
    const host = await screen.findByLabelText('Adres w sieci lokalnej')
    await user.type(host, '8.8.8.8')
    await user.click(screen.getByRole('button', { name: 'Dodaj urządzenie' }))
    expect(host.getAttribute('aria-invalid')).toBe('true')
    expect(fetchFn.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)

    await user.clear(host)
    await user.type(host, '192.168.1.60')
    await user.selectOptions(screen.getByLabelText('Profil urządzenia'), 'simulated.hybrid-inverter@0.1.0')
    await user.type(screen.getByLabelText('Nazwa urządzenia'), 'F')
    await user.type(screen.getByLabelText('Nazwa połączenia'), 'L')
    await user.click(screen.getByRole('button', { name: 'Dodaj urządzenie' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Brak jednoznacznego agenta lokalnego.')
  })

  it('wyłącza urządzenie przyciskiem w panelu szczegółów', async () => {
    const user = userEvent.setup()
    const patched: unknown[] = []
    const fetchFn = server((url, init) => {
      if (url === `/api/sites/${SITE_ID}/devices/d1` && init?.method === 'PATCH') {
        patched.push(JSON.parse(String(init.body)))
        return json(200, { ...DEVICE, enabled: false, status: 'DISABLED' })
      }
      return undefined
    })
    renderPage(fetchFn)
    await user.click(await screen.findByRole('button', { name: 'Wyłącz urządzenie Falownik dach' }))
    await vi.waitFor(() => expect(patched).toEqual([{ enabled: false }]))
  })
})
