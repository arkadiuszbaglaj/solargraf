import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { LiveDevice, LiveReading } from '../api/live'
import type { LiveSite, LiveState } from '../hooks/useLiveSite'
import { mergeReadings } from '../lib/liveValues'
import { SiteDetailsPanels } from './SiteDetailsPanels'

const NOW = new Date('2026-11-07T12:00:00Z')
const DEV = 'inv'

function device(metrics: Array<[string, number?]>): LiveDevice {
  return {
    id: DEV,
    name: 'Falownik',
    kind: 'INVERTER',
    enabled: true,
    freshnessThresholdSeconds: 60,
    metrics: metrics.map(([key, channel]) => ({ key, channel: channel ?? null, name: key, unit: '', cumulative: false })),
  }
}

function reading(metric: string, value: number | null, channel: number | null = null, secondsAgo = 5): LiveReading {
  return {
    deviceId: DEV,
    metric,
    channel,
    value,
    quality: value === null ? 'MISSING' : 'GOOD',
    origin: 'SIMULATED',
    receivedAt: new Date(NOW.getTime() - secondsAgo * 1000).toISOString(),
  }
}

const live = (state: LiveState, retry = vi.fn<() => void>()): LiveSite => ({ state, retry })

const ready = (metrics: Array<[string, number?]>, readings: LiveReading[]): LiveSite =>
  live({ status: 'live', devices: [device(metrics)], readings: mergeReadings(new Map(), readings) })

/** Pary etykieta → tekst wartości w panelu. */
function rows(panel: HTMLElement): string[] {
  return within(panel)
    .getAllByRole('term')
    .map((dt) => `${dt.textContent}: ${dt.nextElementSibling?.textContent}`)
}

describe('SiteDetailsPanels', () => {
  it('panele tylko dla udostępnianych metryk; kierunek baterii i sieci (D39); SIMULATED', () => {
    render(
      <SiteDetailsPanels
        now={NOW}
        live={ready(
          [['pv_power'], ['pv_string_voltage', 1], ['battery_soc'], ['battery_power'], ['grid_power'], ['grid_voltage', 1]],
          [
            reading('pv_power', 3200),
            reading('pv_string_voltage', 410.5, 1),
            reading('battery_soc', 64),
            reading('battery_power', -1500),
            reading('grid_power', 200, null, 20),
          ],
        )}
      />,
    )
    const pv = screen.getByRole('region', { name: 'Fotowoltaika' })
    expect(rows(pv)).toEqual(['Moc całkowita: 3,20 kW', 'Napięcie: 410,5 V'])
    expect(within(pv).getByRole('heading', { name: 'String 1', level: 3 })).toBeTruthy()
    expect(within(pv).getByText('SIMULATED')).toBeTruthy()

    const battery = screen.getByRole('region', { name: 'Magazyn energii' })
    expect(rows(battery)).toEqual(['Stan naładowania: 64%', 'Moc: 1,50 kWładowanie'])

    const grid = screen.getByRole('region', { name: 'Sieć' })
    expect(rows(grid)).toEqual(['Moc: 0,20 kWpobór z sieci', 'Napięcie L1: —brak danych'])
    expect(within(grid).getByText('Odczyt 20 s temu')).toBeTruthy()
  })

  it('bez metryk baterii — brak panelu magazynu; nieaktualna wartość oznaczona', () => {
    render(<SiteDetailsPanels now={NOW} live={ready([['pv_power']], [reading('pv_power', 1000, null, 120)])} />)
    expect(screen.queryByRole('region', { name: 'Magazyn energii' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Sieć' })).toBeNull()
    expect(rows(screen.getByRole('region', { name: 'Fotowoltaika' }))).toEqual([
      'Moc całkowita: 1,00 kWnieaktualne, odczyt 2 min temu',
    ])
  })

  it('profil bez żadnej z metryk — nic nie renderuje', () => {
    const { container } = render(<SiteDetailsPanels now={NOW} live={ready([['load_power']], [])} />)
    expect(container.innerHTML).toBe('')
  })

  it('łączenie i błąd z ponowieniem', async () => {
    const { rerender } = render(<SiteDetailsPanels now={NOW} live={live({ status: 'connecting' })} />)
    expect(screen.getByRole('region', { name: 'Szczegóły instalacji' })).toBeTruthy()
    const retry = vi.fn<() => void>()
    rerender(<SiteDetailsPanels now={NOW} live={live({ status: 'error' }, retry)} />)
    await userEvent.click(screen.getByRole('button', { name: /spróbuj/i }))
    expect(retry).toHaveBeenCalledOnce()
  })
})
