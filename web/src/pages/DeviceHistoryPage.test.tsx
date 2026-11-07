import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ENERGY_BODY } from '../test/energyFixture'
import { historyIds, routeFor } from '../Root'
import { DeviceHistoryPage } from './DeviceHistoryPage'

// ECharts wymaga przeglądarki (wymiary, ResizeObserver); opcje wykresu testujemy osobno.
vi.mock('../components/HistoryChartView', () => ({
  HistoryChartView: ({ label }: { label: string }) => <div role="img" aria-label={label} />,
}))
vi.mock('../components/EnergyBarsView', () => ({
  EnergyBarsView: ({ label }: { label: string }) => <div role="img" aria-label={label} />,
}))

const SITE_ID = '0b5c3a52-6f0e-4d0b-9a77-6a1f2c3d4e5f'
const DEVICE_ID = '1c6d4b63-7f1f-4e1c-8b88-7b2f3d4e5f60'
const SITE = { id: SITE_ID, organization_id: 'o1', name: 'Dom', timezone: 'Europe/Warsaw', role: 'VIEWER' }
const METRICS = [
  { key: 'pv_power', channel: null, name: 'Moc PV', unit: 'W', cumulative: false },
  { key: 'pv_string_voltage', channel: 1, name: 'Napięcie stringu PV', unit: 'V', cumulative: false },
]
const DEVICE = {
  id: DEVICE_ID,
  parent_device_id: null,
  name: 'Falownik dach',
  kind: 'INVERTER',
  manufacturer: null,
  model: null,
  enabled: true,
  status: 'OK',
  last_success_at: null,
  details: null,
  metrics: METRICS,
}
const NOW = new Date('2026-11-07T12:00:00Z')

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

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

function server(historyBody: unknown = history([1000, null]), device: unknown = DEVICE, energyBody: unknown = null) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input)
    if (url === `/api/sites/${SITE_ID}`) return json(200, SITE)
    if (url === `/api/sites/${SITE_ID}/devices`) return json(200, [device])
    if (url.startsWith(`/api/sites/${SITE_ID}/devices/${DEVICE_ID}/history?`)) {
      return historyBody instanceof Response ? historyBody : json(200, historyBody)
    }
    if (energyBody !== null && url.startsWith(`/api/sites/${SITE_ID}/devices/${DEVICE_ID}/energy?`)) {
      return energyBody instanceof Response ? energyBody : json(200, energyBody)
    }
    return json(404, { detail: 'x' })
  })
}

function historyUrls(fetchFn: ReturnType<typeof server>): URL[] {
  return fetchFn.mock.calls
    .map(([input]) => String(input))
    .filter((u) => u.includes('/history?'))
    .map((u) => new URL(u, 'https://x'))
}

describe('trasa historii', () => {
  it('rozpoznaje adres historii urządzenia', () => {
    const path = `/instalacje/${SITE_ID}/urzadzenia/${DEVICE_ID}/historia`
    expect(routeFor(path)).toBe('history')
    expect(historyIds(path)).toEqual({ siteId: SITE_ID, deviceId: DEVICE_ID })
    expect(historyIds(`/instalacje/${SITE_ID}/urzadzenia`)).toBeNull()
  })
})

describe('DeviceHistoryPage', () => {
  it('pokazuje wykres dnia z oznaczeniem SIMULATED i zapytaniem w strefie instalacji', async () => {
    const fetchFn = server()
    render(<DeviceHistoryPage siteId={SITE_ID} deviceId={DEVICE_ID} now={NOW} fetchFn={fetchFn} />)
    expect(await screen.findByRole('img', { name: 'Wykres: Moc PV w kW, 7 listopada 2026.' })).toBeTruthy()
    expect(screen.getByText('SIMULATED')).toBeTruthy()
    expect(screen.getByText(/rozdzielczość: 5 min/)).toBeTruthy()
    const [url] = historyUrls(fetchFn)
    expect(url?.searchParams.get('metric')).toBe('pv_power')
    expect(url?.searchParams.get('from')).toBe('2026-11-06T23:00:00.000Z')
    expect(url?.searchParams.get('to')).toBe('2026-11-07T23:00:00.000Z')
    expect(url?.searchParams.get('resolution')).toBe('auto')
    expect(url?.searchParams.has('channel')).toBe(false)
  })

  it('zmienia metrykę, okres i nawigację', async () => {
    const user = userEvent.setup()
    const fetchFn = server()
    render(<DeviceHistoryPage siteId={SITE_ID} deviceId={DEVICE_ID} now={NOW} fetchFn={fetchFn} />)
    await screen.findByRole('img')
    expect(screen.getByRole('button', { name: 'Następny okres' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Dziś' }).hasAttribute('disabled')).toBe(true)

    await user.selectOptions(screen.getByLabelText('Pomiar'), 'pv_string_voltage|1')
    await user.click(screen.getByRole('button', { name: 'Miesiąc' }))
    expect(screen.getByRole('button', { name: 'Miesiąc' }).getAttribute('aria-pressed')).toBe('true')
    await user.click(screen.getByRole('button', { name: 'Poprzedni okres' }))
    await screen.findByText('październik 2026')
    const last = historyUrls(fetchFn).at(-1)
    expect(last?.searchParams.get('metric')).toBe('pv_string_voltage')
    expect(last?.searchParams.get('channel')).toBe('1')
    expect(last?.searchParams.get('from')).toBe('2026-09-30T22:00:00.000Z')
    expect(screen.getByRole('button', { name: 'Następny okres' }).hasAttribute('disabled')).toBe(false)
  })

  it('zakres bez danych to stan pusty, nie wykres zer', async () => {
    render(
      <DeviceHistoryPage siteId={SITE_ID} deviceId={DEVICE_ID} now={NOW} fetchFn={server(history([null, null], []))} />,
    )
    expect(await screen.findByText('Brak danych w tym okresie.')).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByText('SIMULATED')).toBeNull()
  })

  it('błąd pobrania historii pozwala ponowić', async () => {
    render(
      <DeviceHistoryPage
        siteId={SITE_ID}
        deviceId={DEVICE_ID}
        now={NOW}
        fetchFn={server(json(500, { detail: 'x' }))}
      />,
    )
    expect(await screen.findByRole('button', { name: 'Spróbuj ponownie' })).toBeTruthy()
  })

  it('wygasła sesja przekierowuje do logowania', async () => {
    const navigate = vi.fn<(u: string) => void>()
    render(
      <DeviceHistoryPage
        siteId={SITE_ID}
        deviceId={DEVICE_ID}
        now={NOW}
        fetchFn={server(json(401, { detail: 'x' }))}
        navigate={navigate}
      />,
    )
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/login?reason=expired'))
  })

  it('nieznane urządzenie i urządzenie bez metryk', async () => {
    const { unmount } = render(
      <DeviceHistoryPage siteId={SITE_ID} deviceId={DEVICE_ID} now={NOW} fetchFn={server(undefined, { ...DEVICE, id: 'inne' })} />,
    )
    expect(await screen.findByText('Nie znaleziono urządzenia.')).toBeTruthy()
    unmount()
    render(
      <DeviceHistoryPage siteId={SITE_ID} deviceId={DEVICE_ID} now={NOW} fetchFn={server(undefined, { ...DEVICE, metrics: [] })} />,
    )
    expect(await screen.findByText('Profil urządzenia nie udostępnia pomiarów.')).toBeTruthy()
  })

  it('panel energii: wskaźniki ze statusem, suma i oznaczenie SIMULATED', async () => {
    const device = {
      ...DEVICE,
      metrics: [
        ...METRICS,
        { key: 'pv_energy_total', channel: null, name: 'Produkcja PV (licznik)', unit: 'Wh', cumulative: true },
      ],
    }
    const fetchFn = server(history([1000]), device, ENERGY_BODY)
    render(<DeviceHistoryPage siteId={SITE_ID} deviceId={DEVICE_ID} now={NOW} fetchFn={fetchFn} />)
    const panel = await screen.findByRole('region', { name: 'Energia i wskaźniki' })
    expect(await within(panel).findByText('94,4%')).toBeTruthy()
    expect(within(panel).getByText('Brak.')).toBeTruthy()
    expect(within(panel).getByRole('rowheader', { name: 'Produkcja PV' })).toBeTruthy()
    expect(within(panel).getByText('0,8 kWh')).toBeTruthy()
    expect(within(panel).getByText('wykryto reset licznika')).toBeTruthy()
    expect(within(panel).getByText('SIMULATED')).toBeTruthy()
    expect(await within(panel).findByRole('img', { name: /Wykres słupkowy energii/ })).toBeTruthy()
    const energyUrl = fetchFn.mock.calls.map(([u]) => String(u)).find((u) => u.includes('/energy?'))
    expect(new URL(energyUrl ?? '', 'https://x').searchParams.get('from')).toBe('2026-11-06T23:00:00.000Z')
  })

  it('bez źródeł energii panel jest ukryty', async () => {
    render(<DeviceHistoryPage siteId={SITE_ID} deviceId={DEVICE_ID} now={NOW} fetchFn={server()} />)
    await screen.findByRole('img')
    expect(screen.queryByRole('region', { name: 'Energia i wskaźniki' })).toBeNull()
  })
})
