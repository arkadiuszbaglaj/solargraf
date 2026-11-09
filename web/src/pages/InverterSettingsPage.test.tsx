import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Session } from '../api/auth'
import { parseDevice, validateConnectionSettings } from '../api/devices'
import type { ApiDevice } from '../api/devices'
import { SessionProvider } from '../auth/SessionContext'
import { groupByConnection } from '../lib/connections'
import { inverterSettingsUrl } from '../paths'
import { devicesTabIds, routeFor } from '../Root'
import { InverterSettingsPage } from './InverterSettingsPage'

const SITE_ID = '0b5c3a52-6f0e-4d0b-9a77-6a1f2c3d4e5f'
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
  timeout_seconds: 3,
  live_interval_seconds: 1.5,
}
const DEVICE = {
  id: 'd1',
  parent_device_id: null,
  name: 'Falownik dach',
  kind: 'INVERTER',
  manufacturer: 'SolarGraf',
  model: null,
  enabled: true,
  status: 'OK',
  last_success_at: '2026-11-07T11:59:00Z',
  agent_id: 'a1',
  support_level: 'EXPERIMENTAL',
  details: {
    firmware_version: null,
    serial_number: null,
    profile_id: 'simulated.hybrid-inverter',
    profile_version: '0.1.0',
    connection: CONNECTION,
  },
  metrics: [],
}
const BATTERY = { ...DEVICE, id: 'd2', name: 'Magazyn', kind: 'BATTERY', status: 'STALE' }
const METER = {
  ...DEVICE,
  id: 'd3',
  name: 'Licznik sieci',
  kind: 'METER',
  details: {
    ...DEVICE.details,
    profile_id: 'eastron.sdm630',
    connection: { ...CONNECTION, id: 'c2', name: 'Licznik', host: '192.168.1.52', live_interval_seconds: null },
  },
}
const AGENT = {
  id: 'a1',
  name: 'rpi-garaż',
  status: 'ONLINE',
  last_heartbeat_at: '2026-11-07T11:59:30Z',
  version: '0.12.1',
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

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

function session(role: 'OWNER' | 'ADMIN' | 'VIEWER'): Session {
  return {
    user: { id: 'u1', email: 'jan@example.pl', displayName: 'Jan' },
    memberships: [{ organizationId: 'o1', organizationName: 'Org', role }],
    csrfToken: 'csrf',
  }
}

type Route = (url: string, init?: RequestInit) => Response | undefined

function server(
  route: Route = () => undefined,
  { role = 'OWNER', devices = [DEVICE], agents = [AGENT] }: { role?: string; devices?: object[]; agents?: object[] } = {},
) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    const custom = route(url, init)
    if (custom) return custom
    if (url === `/api/sites/${SITE_ID}`) return json(200, { ...SITE, role })
    if (url === `/api/sites/${SITE_ID}/devices`) {
      return json(200, devices.map((d) => (role === 'VIEWER' ? { ...d, details: null } : d)))
    }
    if (url === `/api/sites/${SITE_ID}/agents`) return json(200, agents)
    if (url === '/api/profiles') return json(200, [PROFILE])
    return json(404, { detail: 'x' })
  })
}

function renderPage(
  fetchFn: typeof fetch,
  s: Session = session('OWNER'),
  props: { origin?: 'DEVICE' | 'DEMO' } = {},
) {
  const navigate = vi.fn<(u: string) => void>()
  render(
    <SessionProvider value={{ session: s, logout: () => undefined, loggingOut: false }}>
      <InverterSettingsPage siteId={SITE_ID} now={NOW} fetchFn={fetchFn} navigate={navigate} {...props} />
    </SessionProvider>,
  )
  return { navigate }
}

const card = async (name: string) => within(await screen.findByRole('article', { name: `Połączenie ${name}` }))

describe('groupByConnection i walidacja edycji', () => {
  const parsed = [DEVICE, BATTERY, METER].map(parseDevice).filter((d): d is ApiDevice => d !== null)

  it('grupuje urządzenia po połączeniu w kolejności wystąpienia; bez szczegółów pomija', () => {
    const groups = groupByConnection(parsed)
    expect(groups.map((g) => [g.connection.name, g.devices.map((d) => d.id)])).toEqual([
      ['Logger', ['d1', 'd2']],
      ['Licznik', ['d3']],
    ])
    expect(groups[0]?.profile).toEqual({ id: 'simulated.hybrid-inverter', version: '0.1.0' })
    const viewer: ApiDevice[] = parsed.map((d) => Object.assign({}, d, { details: null }))
    expect(groupByConnection(viewer)).toEqual([])
  })

  it('limit czasu przenoszony bez zmian; profil daje domyślny interwał zapisu', () => {
    const form = {
      name: ' Logger ',
      host: '192.168.1.60',
      port: '502',
      unitId: '2',
      pollIntervalSeconds: '',
      liveIntervalSeconds: '1,5',
    }
    expect(validateConnectionSettings(form, 10, 3)).toEqual({
      errors: {},
      input: {
        name: 'Logger',
        host: '192.168.1.60',
        port: 502,
        unitId: 2,
        pollIntervalSeconds: null,
        liveIntervalSeconds: 1.5,
        timeoutSeconds: 3,
      },
    })
    // Podgląd rzadszy niż zapis z profilu (10 s) — błąd; bez profilu serwer rozstrzyga sam.
    expect(validateConnectionSettings({ ...form, liveIntervalSeconds: '12' }, 10, null).errors.liveIntervalSeconds).toMatch(
      /rzadsze/,
    )
    expect(validateConnectionSettings({ ...form, liveIntervalSeconds: '12' }, null, null).errors).toEqual({})
    const bad = validateConnectionSettings({ ...form, name: '', host: '8.8.8.8', port: '0' }, 10, null)
    expect(bad.input).toBeNull()
    expect(Object.keys(bad.errors).toSorted()).toEqual(['host', 'name', 'port'])
  })

  it('adres zakładki z wybraną instalacją', () => {
    expect(routeFor('/ustawienia/falownik')).toBe('inverter')
    expect(routeFor('/ustawienia/falownik/')).toBe('inverter')
    expect(inverterSettingsUrl(SITE_ID)).toBe(`/ustawienia/falownik?instalacja=${SITE_ID}`)
    expect(devicesTabIds('/ustawienia/falownik', `?instalacja=${SITE_ID}`).siteId).toBe(SITE_ID)
  })
})

describe('InverterSettingsPage', () => {
  it('właściciel widzi agenta i połączenia z urządzeniami', async () => {
    renderPage(server(undefined, { devices: [DEVICE, BATTERY, METER] }))
    const agents = await screen.findByRole('table', { name: 'Agenci instalacji Dom' })
    const row = within(agents).getByRole('row', { name: /rpi-garaż/ })
    expect(row.textContent).toContain('połączony')
    expect(row.textContent).toContain('07.11.2026, 12:59')
    expect(row.textContent).toContain('0.12.1')

    const logger = await card('Logger')
    expect(logger.getByText('192.168.1.50:502')).toBeTruthy()
    expect(logger.getByText('z profilu')).toBeTruthy() // interwał odczytu
    expect(logger.getByText('1,5 s')).toBeTruthy()
    expect(logger.getByText('SIMULATED')).toBeTruthy()
    const items = within(logger.getByRole('list', { name: 'Urządzenia połączenia Logger' })).getAllByRole('listitem')
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining('Falownik dach'),
      expect.stringContaining('Magazyn'),
    ])
    expect(within(items[1] as HTMLElement).getByText('Dane nieaktualne')).toBeTruthy()
    expect(logger.getByRole('link', { name: 'Falownik dach' }).getAttribute('href')).toBe(
      `/urzadzenia?instalacja=${SITE_ID}&urzadzenie=d1`,
    )
    expect((await card('Licznik')).getByText('192.168.1.52:502')).toBeTruthy()
    expect(screen.queryByText(/Agent nie odpowiada/)).toBeNull()
  })

  it('agent nieosiągalny — ostrzeżenie; brak agenta i połączeń — stany puste', async () => {
    renderPage(server(undefined, { agents: [{ ...AGENT, status: 'UNREACHABLE', version: null }] }))
    expect(await screen.findByText(/Agent nie odpowiada/)).toBeTruthy()
    expect(screen.getByText('nieosiągalny')).toBeTruthy()
    expect(screen.getByText('niedostępna')).toBeTruthy() // wersja bez danych, nie „0”
  })

  it('bez urządzeń i agenta pokazuje stany puste', async () => {
    renderPage(server(undefined, { devices: [], agents: [] }))
    expect(await screen.findByText(/Brak agenta/)).toBeTruthy()
    expect(screen.getByText(/Brak połączeń/)).toBeTruthy()
  })

  it('podgląd (VIEWER) nie zmienia konfiguracji', async () => {
    renderPage(server(undefined, { role: 'VIEWER' }), session('VIEWER'))
    expect(await screen.findByText(/zmienia właściciel albo administrator/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('tryb DEMO: wymaga serwera, bez zapytań', () => {
    const fetchFn = server()
    renderPage(fetchFn, session('OWNER'), { origin: 'DEMO' })
    expect(screen.getByText(/niedostępna w trybie DEMO/)).toBeTruthy()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('wygasła sesja przekierowuje do logowania', async () => {
    const { navigate } = renderPage(server((url) => (url.endsWith('/agents') ? json(401, {}) : undefined)))
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/login?reason=expired'))
  })

  it('edycja połączenia: PATCH z tokenem CSRF i zachowanym limitem czasu', async () => {
    const user = userEvent.setup()
    const patched: unknown[] = []
    const csrf: (string | null)[] = []
    const fetchFn = server((url, init) => {
      if (url === `/api/sites/${SITE_ID}/connections/c1` && init?.method === 'PATCH') {
        csrf.push(new Headers(init.headers).get('X-CSRF-Token'))
        patched.push(JSON.parse(String(init.body)))
        return json(200, { ...CONNECTION, host: '192.168.1.60', poll_interval_seconds: 30 })
      }
      return undefined
    })
    renderPage(fetchFn)
    await user.click(await screen.findByRole('button', { name: 'Edytuj połączenie Logger' }))
    const form = within(screen.getByRole('form', { name: 'Edycja połączenia Logger' }))
    expect((form.getByLabelText('Odświeżanie na żywo [s]') as HTMLInputElement).value).toBe('1,5')
    expect(await form.findByText(/Puste = z profilu \(10 s\)/)).toBeTruthy()
    const host = form.getByLabelText('Adres w sieci lokalnej')
    await user.clear(host)
    await user.type(host, '192.168.1.60')
    await user.type(form.getByLabelText('Interwał odczytu [s]'), '30')
    await user.click(form.getByRole('button', { name: 'Zapisz połączenie' }))
    expect(await screen.findByText('Zapisano ustawienia połączenia „Logger”.')).toBeTruthy()
    expect(csrf).toEqual(['csrf'])
    expect(patched).toEqual([
      {
        name: 'Logger',
        host: '192.168.1.60',
        port: 502,
        unit_id: 1,
        poll_interval_seconds: 30,
        live_interval_seconds: 1.5,
        timeout_seconds: 3,
      },
    ])
    expect(screen.queryByRole('form', { name: 'Edycja połączenia Logger' })).toBeNull()
  })

  it('edycja połączenia: błąd w przeglądarce bez żądania, komunikat serwera, anulowanie', async () => {
    const user = userEvent.setup()
    const fetchFn = server((url, init) =>
      url.endsWith('/connections/c1') && init?.method === 'PATCH'
        ? json(422, { detail: [{ msg: 'Value error, Limit czasu musi być krótszy niż interwał odczytu.' }] })
        : undefined,
    )
    renderPage(fetchFn)
    await user.click(await screen.findByRole('button', { name: 'Edytuj połączenie Logger' }))
    const form = within(screen.getByRole('form', { name: 'Edycja połączenia Logger' }))
    const host = form.getByLabelText('Adres w sieci lokalnej')
    await user.clear(host)
    await user.type(host, '8.8.8.8')
    await user.click(form.getByRole('button', { name: 'Zapisz połączenie' }))
    expect(host.getAttribute('aria-invalid')).toBe('true')
    expect(fetchFn.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false)

    await user.clear(host)
    await user.type(host, '192.168.1.50')
    await user.type(form.getByLabelText('Interwał odczytu [s]'), '2')
    await user.click(form.getByRole('button', { name: 'Zapisz połączenie' }))
    expect((await form.findByRole('alert')).textContent).toBe('Limit czasu musi być krótszy niż interwał odczytu.')

    await user.click(form.getByRole('button', { name: 'Anuluj' }))
    expect(screen.queryByRole('form', { name: 'Edycja połączenia Logger' })).toBeNull()
    expect((await card('Logger')).getByText('192.168.1.50:502')).toBeTruthy()
  })

  it('edycja połączenia: test komunikacji nowego adresu profilem urządzeń', async () => {
    const user = userEvent.setup()
    const tests: unknown[] = []
    const fetchFn = server((url, init) => {
      if (url === `/api/sites/${SITE_ID}/connection-tests` && init?.method === 'POST') {
        tests.push(JSON.parse(String(init.body)))
        return json(202, { id: 't1', state: 'DONE', result: 'OK', error_code: null, origin: 'SIMULATED', readings: [] })
      }
      return undefined
    })
    renderPage(fetchFn)
    await user.click(await screen.findByRole('button', { name: 'Edytuj połączenie Logger' }))
    const form = within(screen.getByRole('form', { name: 'Edycja połączenia Logger' }))
    const host = form.getByLabelText('Adres w sieci lokalnej')
    await user.clear(host)
    await user.type(host, '192.168.1.61')
    await user.click(await form.findByRole('button', { name: 'Testuj połączenie' }))
    await vi.waitFor(() =>
      expect(tests).toEqual([
        { host: '192.168.1.61', port: 502, unit_id: 1, profile_id: 'simulated.hybrid-inverter', profile_version: '0.1.0' },
      ]),
    )
  })

  it('edycja połączenia z profilem spoza katalogu — bez testu komunikacji', async () => {
    const user = userEvent.setup()
    renderPage(server(undefined, { devices: [METER] }))
    await user.click(await screen.findByRole('button', { name: 'Edytuj połączenie Licznik' }))
    await screen.findByLabelText('Adres w sieci lokalnej')
    expect(screen.queryByRole('button', { name: 'Testuj połączenie' })).toBeNull()
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
    await user.type(screen.getByLabelText('Nazwa urządzenia'), 'Nowy')
    await user.type(screen.getByLabelText('Nazwa połączenia'), 'Logger 2')
    await user.type(screen.getByLabelText('Adres w sieci lokalnej'), '192.168.1.60')
    const form = screen.getByRole('region', { name: 'Dodaj urządzenie (Modbus TCP)' })
    await user.click(within(form).getByRole('button', { name: 'Dodaj urządzenie' }))
    expect(await screen.findByText(/Dodano „Nowy”/)).toBeTruthy()
    expect(csrf).toEqual(['csrf'])
    expect(posted).toEqual([
      {
        name: 'Logger 2',
        host: '192.168.1.60',
        port: 502,
        unit_id: 1,
        poll_interval_seconds: null,
        live_interval_seconds: null,
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
    renderPage(fetchFn, session('OWNER'))
    await user.click(await screen.findByRole('button', { name: 'Dodaj urządzenie' }))
    expect(await screen.findByRole('group', { name: '1. Profil i adres' })).toBeTruthy()
    expect(screen.getByRole('group', { name: '2. Test komunikacji' })).toBeTruthy()
    expect(screen.getByRole('group', { name: '3. Nazwy i zapis' })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Testuj połączenie' }))
    expect(tests).toEqual([])
    expect(screen.getByLabelText('Adres w sieci lokalnej').getAttribute('aria-invalid')).toBe('true')

    await user.selectOptions(screen.getByLabelText('Profil urządzenia'), 'simulated.hybrid-inverter@0.1.0')
    await user.type(screen.getByLabelText('Adres w sieci lokalnej'), '192.168.1.60')
    await user.click(screen.getByRole('button', { name: 'Testuj połączenie' }))
    expect(await screen.findByText(/Połączenie działa — odczytano wszystkie parametry/)).toBeTruthy()
    expect(tests).toEqual([
      { host: '192.168.1.60', port: 502, unit_id: 1, profile_id: 'simulated.hybrid-inverter', profile_version: '0.1.0' },
    ])
    await user.type(screen.getByLabelText('Adres w sieci lokalnej'), '1')
    expect(screen.queryByText(/Połączenie działa/)).toBeNull()
  })

  it('kreator: błąd walidacji bez żądania; komunikat serwera jest pokazany', async () => {
    const user = userEvent.setup()
    const fetchFn = server((url, init) =>
      url.endsWith('/connections') && init?.method === 'POST'
        ? json(409, { detail: 'Brak jednoznacznego agenta lokalnego.' })
        : undefined,
    )
    renderPage(fetchFn)
    await user.click(await screen.findByRole('button', { name: 'Dodaj urządzenie' }))
    const form = within(screen.getByRole('region', { name: 'Dodaj urządzenie (Modbus TCP)' }))
    const host = await form.findByLabelText('Adres w sieci lokalnej')
    await user.type(host, '8.8.8.8')
    await user.click(form.getByRole('button', { name: 'Dodaj urządzenie' }))
    expect(host.getAttribute('aria-invalid')).toBe('true')
    expect(fetchFn.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)

    await user.clear(host)
    await user.type(host, '192.168.1.60')
    await user.selectOptions(form.getByLabelText('Profil urządzenia'), 'simulated.hybrid-inverter@0.1.0')
    await user.type(form.getByLabelText('Nazwa urządzenia'), 'F')
    await user.type(form.getByLabelText('Nazwa połączenia'), 'L')
    await user.click(form.getByRole('button', { name: 'Dodaj urządzenie' }))
    expect((await form.findByRole('alert')).textContent).toContain('Brak jednoznacznego agenta lokalnego.')
  })

  it('wyłącza odczyt urządzenia; błąd serwera jest pokazany', async () => {
    const user = userEvent.setup()
    const patched: unknown[] = []
    const fetchFn = server((url, init) => {
      if (url === `/api/sites/${SITE_ID}/devices/d1` && init?.method === 'PATCH') {
        patched.push(JSON.parse(String(init.body)))
        return patched.length === 1 ? json(200, { ...DEVICE, enabled: false, status: 'DISABLED' }) : json(403, {})
      }
      return undefined
    })
    renderPage(fetchFn)
    await user.click(await screen.findByRole('button', { name: 'Wyłącz odczyt urządzenia Falownik dach' }))
    await vi.waitFor(() => expect(patched).toEqual([{ enabled: false }]))
    await user.click(screen.getByRole('button', { name: 'Wyłącz odczyt urządzenia Falownik dach' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Nie masz uprawnień')
  })
})
