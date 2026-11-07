import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Session } from '../api/auth'
import type { ApiProfile, ConnectionForm } from '../api/devices'
import { parseDevice, parseProfile, validateConnection } from '../api/devices'
import { SessionProvider } from '../auth/SessionContext'
import { devicesSiteId, routeFor } from '../Root'
import { DevicesPage } from './DevicesPage'

const SITE_ID = '0b5c3a52-6f0e-4d0b-9a77-6a1f2c3d4e5f'
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

function server(route: Route = () => undefined, role: 'OWNER' | 'VIEWER' = 'OWNER') {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    const custom = route(url, init)
    if (custom) return custom
    if (url === `/api/sites/${SITE_ID}`) return json(200, { ...SITE, role })
    if (url === `/api/sites/${SITE_ID}/devices`) {
      return json(200, [role === 'VIEWER' ? { ...DEVICE, details: null } : DEVICE])
    }
    if (url === '/api/profiles') return json(200, [PROFILE])
    return json(404, { detail: 'x' })
  })
}

function renderPage(fetchFn: typeof fetch, s: Session = session('OWNER'), navigate = vi.fn<(u: string) => void>()) {
  render(
    <SessionProvider value={{ session: s, logout: () => undefined, loggingOut: false }}>
      <DevicesPage siteId={SITE_ID} fetchFn={fetchFn} navigate={navigate} />
    </SessionProvider>,
  )
  return navigate
}

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
  it('rozpoznaje adres ekranu urządzeń', () => {
    expect(routeFor(`/instalacje/${SITE_ID}/urzadzenia`)).toBe('devices')
    expect(devicesSiteId(`/instalacje/${SITE_ID}/urzadzenia/`)).toBe(SITE_ID)
    expect(routeFor('/instalacje/../urzadzenia')).toBe('app')
    expect(devicesSiteId('/instalacje/x/urzadzenia')).toBeNull()
  })
})

describe('DevicesPage', () => {
  it('właściciel widzi status słowem, profil SIMULATED i adres', async () => {
    renderPage(server())
    const row = (await screen.findByRole('cell', { name: 'Falownik dach' })).closest('tr')
    if (!row) throw new Error('brak wiersza')
    const cells = within(row)
    expect(cells.getByText('Dane nieaktualne')).toBeTruthy()
    expect(cells.getByText('Falownik')).toBeTruthy()
    expect(cells.getByText(/SIMULATED/)).toBeTruthy()
    expect(cells.getByText('192.168.1.50:502')).toBeTruthy()
    expect(cells.getByText('07.11.2026, 12:05')).toBeTruthy()
    const level = cells.getByText('Eksperymentalny')
    expect(level.getAttribute('title')).toContain('Nie polegaj na odczytach')
    expect(await screen.findByRole('button', { name: 'Dodaj urządzenie' })).toBeTruthy()
  })

  it('podgląd (VIEWER) nie widzi szczegółów ani formularza', async () => {
    renderPage(server(undefined, 'VIEWER'), session('VIEWER'))
    await screen.findByRole('cell', { name: 'Falownik dach' })
    expect(screen.queryByText('192.168.1.50:502')).toBeNull()
    expect(screen.queryByRole('button', { name: /Wyłącz/ })).toBeNull()
    expect(screen.queryByText('Dodaj urządzenie (Modbus TCP)')).toBeNull()
    expect(screen.getByText('Eksperymentalny')).toBeTruthy() // poziom wsparcia widzi każda rola
  })

  it('nieznana lub cudza instalacja', async () => {
    renderPage(server((url) => (url === `/api/sites/${SITE_ID}` ? json(404, { detail: 'x' }) : undefined)))
    expect(await screen.findByText('Nie znaleziono instalacji.')).toBeTruthy()
  })

  it('wygasła sesja przekierowuje do logowania', async () => {
    const navigate = renderPage(server((url) => (url === `/api/sites/${SITE_ID}` ? json(401, {}) : undefined)))
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/login?reason=expired'))
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
    await user.selectOptions(await screen.findByLabelText('Profil urządzenia'), 'simulated.hybrid-inverter@0.1.0')
    expect(screen.getByText(/profil symulatora do testów/)).toBeTruthy()
    expect(screen.getByText(/Wsparcie profilu: Eksperymentalny\. Profil niepełny/)).toBeTruthy()
    await user.type(screen.getByLabelText('Nazwa urządzenia'), 'Nowy')
    await user.type(screen.getByLabelText('Nazwa połączenia'), 'Logger')
    await user.type(screen.getByLabelText('Adres w sieci lokalnej'), '192.168.1.60')
    await user.click(screen.getByRole('button', { name: 'Dodaj urządzenie' }))
    expect((await screen.findByRole('status')).textContent).toContain('Dodano „Nowy”')
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

  it('błąd walidacji w przeglądarce nie wysyła żądania; komunikat serwera jest pokazany', async () => {
    const user = userEvent.setup()
    const fetchFn = server((url, init) =>
      url.endsWith('/connections') && init?.method === 'POST'
        ? json(409, { detail: 'Brak jednoznacznego agenta lokalnego.' })
        : undefined,
    )
    renderPage(fetchFn)
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

  it('wyłącza urządzenie przyciskiem w wierszu', async () => {
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
