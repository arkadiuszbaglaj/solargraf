import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CLOSED, parseReadings, parseSnapshot, type LiveEventSource, type LiveSourceFactory } from '../api/live'
import { RECONNECT_MS, useLiveSite } from '../hooks/useLiveSite'
import type { TodayState } from '../lib/today'
import { parseSiteEnergy } from '../api/energy'
import { ENERGY_BODY, KPI } from '../test/energyFixture'
import { LiveKpiRow } from './LiveKpiRow'

const NOW = new Date('2026-11-07T12:00:00Z')
const SITE = '11111111-1111-1111-1111-111111111111'
const DEV = '22222222-2222-2222-2222-222222222222'

class FakeSource implements LiveEventSource {
  readyState = 1
  closed = false
  private listeners = new Map<string, (event: MessageEvent<string>) => void>()
  readonly url: string

  constructor(url: string) {
    this.url = url
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, listener)
  }

  close(): void {
    this.closed = true
  }

  emit(type: string, data: unknown): void {
    act(() => this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(data) })))
  }

  fail(readyState: number): void {
    this.readyState = readyState
    act(() => this.listeners.get('error')?.(new MessageEvent('error')))
  }
}

const metric = (key: string, unit = 'W') => ({ key, channel: null, name: key, unit, cumulative: false })

function reading(metricKey: string, value: number | null, secondsAgo: number, origin = 'SIMULATED') {
  return {
    device_id: DEV,
    metric: metricKey,
    channel: null,
    value,
    quality: value === null ? 'MISSING' : 'GOOD',
    origin,
    received_at: new Date(NOW.getTime() - secondsAgo * 1000).toISOString(),
  }
}

const SNAPSHOT = {
  site_id: SITE,
  timezone: 'Europe/Warsaw',
  server_time: NOW.toISOString(),
  devices: [
    {
      id: DEV,
      name: 'Falownik',
      kind: 'INVERTER',
      enabled: true,
      freshness_threshold_seconds: 300,
      metrics: [metric('pv_power'), metric('grid_power'), metric('battery_power'), metric('battery_soc', '%')],
    },
  ],
  readings: [
    reading('pv_power', 2500, 12),
    reading('grid_power', -800, 12),
    reading('battery_power', 400, 12),
    reading('battery_soc', null, 12),
  ],
}

function Row({ factory, today }: { factory: LiveSourceFactory; today?: TodayState }) {
  const live = useLiveSite(SITE, factory)
  return <LiveKpiRow live={live} now={NOW} {...(today ? { today } : {})} />
}

function setup() {
  const sources: FakeSource[] = []
  const factory = (url: string) => {
    const s = new FakeSource(url)
    sources.push(s)
    return s
  }
  const view = render(<Row factory={factory} />)
  return { sources, view, current: () => sources[sources.length - 1] as FakeSource }
}

const card = (name: string) => screen.getByRole('heading', { name }).closest('article')?.textContent ?? ''

describe('LiveKpiRow', () => {
  it('łączy się ze strumieniem instalacji i pokazuje ładowanie do migawki', () => {
    const { current } = setup()
    expect(current().url).toBe(`/api/sites/${SITE}/live`)
    expect(screen.getByRole('status').textContent).toContain('Ładowanie')
  })

  it('pokazuje wartości z wiekiem, kierunki wg D39 i oznaczenie SIMULATED', () => {
    const { current } = setup()
    current().emit('snapshot', SNAPSHOT)
    expect(card('Produkcja PV')).toContain('2,50 kW')
    expect(card('Produkcja PV')).toContain('Odczyt 12 s temu')
    expect(card('Sieć')).toContain('oddawanie do sieci')
    expect(card('Magazyn energii')).toContain('rozładowanie')
    // SOC bez odczytu — brak danych, nie 0 %.
    expect(card('Magazyn energii')).toContain('Brak danych')
    expect(card('Magazyn energii')).not.toContain('0%')
    // Profil nie podaje zużycia domu — parametr niedostępny.
    expect(card('Zużycie domu')).toContain('nie podają tego parametru')
    expect(screen.getByLabelText('Dane symulowane')).toBeTruthy()
  })

  it('aktualizuje wartości z kolejnych zdarzeń i oznacza nieaktualne', () => {
    const { current } = setup()
    current().emit('snapshot', SNAPSHOT)
    current().emit('readings', { readings: [reading('pv_power', 1000, 2)] })
    expect(card('Produkcja PV')).toContain('1,00 kW')
    current().emit('readings', { readings: [reading('grid_power', 300, 400)] })
    // Starszy odczyt nie nadpisuje nowszego.
    expect(card('Sieć')).toContain('oddawanie do sieci')
  })

  it('wartość starsza niż próg świeżości jest nieaktualna', () => {
    const { current } = setup()
    current().emit('snapshot', { ...SNAPSHOT, readings: [reading('pv_power', 2500, 301)] })
    expect(card('Produkcja PV')).toContain('Wartość nieaktualna')
  })

  it('przy zerwaniu i zamknięciu strumienia zostawia dane i łączy się ponownie po 10 s', () => {
    vi.useFakeTimers()
    try {
      const { current, sources } = setup()
      current().emit('snapshot', SNAPSHOT)
      current().fail(0)
      expect(screen.getByRole('status').textContent).toContain('Utracono połączenie')
      expect(card('Produkcja PV')).toContain('2,50 kW')
      current().fail(CLOSED)
      expect(card('Produkcja PV')).toContain('2,50 kW')
      expect(sources[0]?.closed).toBe(true)
      act(() => vi.advanceTimersByTime(RECONNECT_MS))
      expect(sources).toHaveLength(2)
      current().emit('snapshot', SNAPSHOT)
      expect(screen.queryByText(/Utracono połączenie/)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('bez danych zamknięty strumień to błąd z przyciskiem ponowienia', async () => {
    const { current, sources } = setup()
    current().fail(CLOSED)
    await userEvent.click(screen.getByRole('button', { name: 'Spróbuj ponownie' }))
    expect(sources).toHaveLength(2)
    expect(sources[0]?.closed).toBe(true)
  })
})

describe('LiveKpiRow — energia dziś (D51)', () => {
  it('pokazuje „Dziś” w kartach i autokonsumpcję z niepełnymi danymi', () => {
    const data = parseSiteEnergy({
      ...ENERGY_BODY,
      series: [{ ...ENERGY_BODY.series[0], device_id: DEV, total_wh: 12_400, coverage: 1, reset_detected: false }],
      kpis: { ...ENERGY_BODY.kpis, self_consumption: { ...KPI, value: 0.5, status: 'INCOMPLETE', coverage: 0.6 } },
      unavailable: [{ key: 'grid_import', metric: 'grid_import_energy_total', reason: 'NOT_PROVIDED', sources: 0 }],
    })
    if (!data) throw new Error('fixture')
    const source = new FakeSource('')
    render(<Row factory={() => source} today={{ status: 'ready', data }} />)
    source.emit('snapshot', SNAPSHOT)
    expect(card('Produkcja PV')).toContain('Dziś: 12,4 kWh')
    expect(card('Sieć')).toContain('Dziś: pobór niedostępne')
    expect(card('Autokonsumpcja')).toContain('50%')
    expect(card('Autokonsumpcja')).toContain('Dane niepełne (pokrycie 60%)')
  })
})

describe('parsery zdarzeń', () => {
  it('odrzucają niepoprawne dane zamiast zgadywać', () => {
    expect(parseSnapshot('nie json')).toBeNull()
    expect(parseSnapshot(JSON.stringify({ ...SNAPSHOT, readings: [{ metric: 'pv_power' }] }))).toBeNull()
    expect(parseReadings(JSON.stringify({ readings: [{ ...reading('pv_power', 1, 1), value: '1' }] }))).toBeNull()
    expect(parseReadings(JSON.stringify({ readings: [{ ...reading('pv_power', 1, 1), quality: 'OK' }] }))).toBeNull()
    expect(parseSnapshot(JSON.stringify(SNAPSHOT))?.devices[0]?.freshnessThresholdSeconds).toBe(300)
  })
})
