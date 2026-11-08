import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { LiveDevice, LiveReading } from '../api/live'
import type { LiveSite, LiveState } from '../hooks/useLiveSite'
import { mergeReadings } from '../lib/liveValues'
import { EnergyFlowPanel } from './EnergyFlowPanel'

const NOW = new Date('2026-11-07T12:00:00Z')
const DEV = 'dev-1'

const metric = (key: string) => ({ key, channel: null, name: key, unit: 'W', cumulative: false })

function device(metrics: string[]): LiveDevice {
  return {
    id: DEV,
    name: 'Falownik',
    kind: 'INVERTER',
    enabled: true,
    freshnessThresholdSeconds: 300,
    metrics: metrics.map(metric),
  }
}

function reading(metricKey: string, value: number | null, secondsAgo = 5): LiveReading {
  return {
    deviceId: DEV,
    metric: metricKey,
    channel: null,
    value,
    quality: value === null ? 'MISSING' : 'GOOD',
    origin: 'SIMULATED',
    receivedAt: new Date(NOW.getTime() - secondsAgo * 1000).toISOString(),
  }
}

const live = (state: LiveState): LiveSite => ({ state, retry: vi.fn<() => void>() })

const ready = (metrics: string[], readings: LiveReading[]): LiveSite =>
  live({ status: 'live', devices: [device(metrics)], readings: mergeReadings(new Map(), readings) })

const ALL = ['pv_power', 'grid_power', 'battery_power', 'load_power']
const values = () => within(screen.getByRole('list', { name: 'Wartości przepływu' })).getAllByRole('listitem').map((li) => li.textContent)

describe('EnergyFlowPanel', () => {
  it('spójny bilans: wartości z kierunkami (D39), oznaczenie SIMULATED, strzałki', () => {
    const { container } = render(
      <EnergyFlowPanel
        now={NOW}
        live={ready(ALL, [
          reading('pv_power', 4000),
          reading('grid_power', -1000),
          reading('battery_power', -2000),
          reading('load_power', 1000),
        ])}
      />,
    )
    expect(values()).toEqual([
      'Produkcja PV: 4,00 kW, produkcja',
      'Sieć: 1,00 kW, oddawanie do sieci',
      'Magazyn energii: 2,00 kW, ładowanie',
      'Zużycie domu: 1,00 kW, zużycie',
    ])
    expect(screen.getByText('SIMULATED')).toBeTruthy()
    expect(container.querySelectorAll('line[marker-end]')).toHaveLength(4)
    expect(screen.queryByText(/nie są pokazywane/)).toBeNull()
    // Animacja na każdej linii w kierunku przepływu; większa moc — szybciej i grubiej (D64).
    const flows = [...container.querySelectorAll<SVGLineElement>('line[data-flow]')]
    expect(flows.map((l) => l.dataset.flow)).toEqual(['in', 'out', 'out', 'out'])
    const pv = flows[0]
    const home = flows[3]
    expect(pv?.style.animationDuration).toBe('1s')
    expect(home?.style.animationDuration).toBe('1.6s')
    expect(Number(pv?.getAttribute('stroke-width'))).toBeGreaterThan(Number(home?.getAttribute('stroke-width')))
  })

  it('moc poniżej progu szumu: bez strzałki i bez ruchu na tej linii', () => {
    const { container } = render(
      <EnergyFlowPanel
        now={NOW}
        live={ready(ALL, [
          reading('pv_power', 3000),
          reading('grid_power', -1000),
          reading('battery_power', 20),
          reading('load_power', 2000),
        ])}
      />,
    )
    expect(container.querySelectorAll('line[marker-end]')).toHaveLength(3)
    expect([...container.querySelectorAll<SVGLineElement>('line[data-flow]')].map((l) => l.dataset.flow)).toEqual([
      'in',
      'out',
      'out',
    ])
  })

  it('nieaktualna wartość: bez strzałek i bez animacji', () => {
    const { container } = render(
      <EnergyFlowPanel
        now={NOW}
        live={ready(ALL, [
          reading('pv_power', 4000, 400),
          reading('grid_power', -1000),
          reading('battery_power', -2000),
          reading('load_power', 1000),
        ])}
      />,
    )
    expect(screen.getByText(/brak świeżych danych: Produkcja PV/)).toBeTruthy()
    expect(container.querySelectorAll('line[marker-end]')).toHaveLength(0)
    expect(container.querySelectorAll('line[data-flow]')).toHaveLength(0)
  })

  it('niedomknięty bilans: wartości bez strzałek i powód', () => {
    const { container } = render(
      <EnergyFlowPanel
        now={NOW}
        live={ready(['pv_power', 'grid_power', 'load_power'], [
          reading('pv_power', 4820),
          reading('grid_power', 680),
          reading('load_power', 3120),
        ])}
      />,
    )
    expect(screen.getByText(/Bilans się nie domyka \(różnica 2,38 kW\)/)).toBeTruthy()
    expect(container.querySelectorAll('line[marker-end]')).toHaveLength(0)
    expect(container.querySelectorAll('line[data-flow]')).toHaveLength(0)
    // Bez źródła baterii węzeł jest ukryty.
    expect(values()).toHaveLength(3)
  })

  it('brak źródła sieci i brak odczytu: „parametr niedostępny”, „brak danych”, nigdy 0', () => {
    render(<EnergyFlowPanel now={NOW} live={ready(['pv_power', 'load_power'], [reading('pv_power', null)])} />)
    expect(values()).toEqual([
      'Produkcja PV: —, brak danych',
      'Sieć: —, parametr niedostępny',
      'Zużycie domu: —, brak danych',
    ])
    expect(screen.getByText(/brak świeżych danych: Produkcja PV, Sieć, Zużycie domu/)).toBeTruthy()
  })

  it('ładowanie i błąd strumienia', () => {
    const { unmount } = render(<EnergyFlowPanel now={NOW} live={live({ status: 'connecting' })} />)
    expect(screen.getByRole('status').textContent).toContain('Ładowanie')
    unmount()
    render(<EnergyFlowPanel now={NOW} live={live({ status: 'error' })} />)
    expect(screen.getByRole('button', { name: /Spróbuj ponownie/ })).toBeTruthy()
  })
})
