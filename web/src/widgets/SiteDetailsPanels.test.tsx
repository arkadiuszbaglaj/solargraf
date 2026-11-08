import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { LiveDevice, LiveReading } from '../api/live'
import type { LiveSite, LiveState } from '../hooks/useLiveSite'
import { mergeReadings } from '../lib/liveValues'
import type { SiteEnergy } from '../api/energy'
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
    expect(within(pv).getByRole('heading', { name: 'MPPT 1', level: 3 })).toBeTruthy()
    expect(within(pv).queryByRole('tablist')).toBeNull()
    expect(within(pv).getByText('SIMULATED')).toBeTruthy()

    const battery = screen.getByRole('region', { name: 'Magazyn energii' })
    expect(rows(battery)).toEqual(['Moc: 1,50 kWładowanie'])
    expect(within(battery).getByText('64%')).toBeTruthy()

    const grid = screen.getByRole('region', { name: 'Sieć' })
    expect(rows(grid)).toEqual(['Moc: 0,20 kWpobór z sieci'])
    const phase = within(grid).getByRole('row', { name: /L1/ })
    expect(phase.textContent).toBe('L1—brak danych')
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

  it('kilka stringów — zakładki MPPT obsługiwane strzałkami, Home i End', async () => {
    render(
      <SiteDetailsPanels
        now={NOW}
        live={ready(
          [['pv_string_power', 1], ['pv_string_power', 2], ['pv_string_power', 3]],
          [reading('pv_string_power', 1000, 1), reading('pv_string_power', 2000, 2), reading('pv_string_power', 3000, 3)],
        )}
      />,
    )
    const pv = screen.getByRole('region', { name: 'Fotowoltaika' })
    const tabs = within(pv).getAllByRole('tab')
    expect(tabs.map((t) => [t.textContent, t.getAttribute('aria-selected'), t.tabIndex])).toEqual([
      ['MPPT 1', 'true', 0],
      ['MPPT 2', 'false', -1],
      ['MPPT 3', 'false', -1],
    ])
    expect(rows(within(pv).getByRole('tabpanel'))).toEqual(['Moc: 1,00 kW'])
    await userEvent.click(tabs[0]!)
    await userEvent.keyboard('{ArrowRight}')
    expect(document.activeElement?.textContent).toBe('MPPT 2')
    expect(rows(within(pv).getByRole('tabpanel', { name: 'MPPT 2' }))).toEqual(['Moc: 2,00 kW'])
    await userEvent.keyboard('{End}')
    expect(document.activeElement?.textContent).toBe('MPPT 3')
    await userEvent.keyboard('{ArrowRight}')
    expect(document.activeElement?.textContent).toBe('MPPT 1')
    await userEvent.keyboard('{ArrowLeft}')
    expect(document.activeElement?.textContent).toBe('MPPT 3')
    await userEvent.keyboard('{Home}')
    expect(rows(within(pv).getByRole('tabpanel', { name: 'MPPT 1' }))).toEqual(['Moc: 1,00 kW'])
  })

  it('magazyn: SoC w pierścieniu i szacunek energii z pojemności; bez pojemności — bez szacunku', () => {
    const { unmount } = render(
      <SiteDetailsPanels
        now={NOW}
        live={ready([['battery_soc'], ['battery_capacity']], [reading('battery_soc', 50), reading('battery_capacity', 10_000)])}
      />,
    )
    const battery = screen.getByRole('region', { name: 'Magazyn energii' })
    expect(within(battery).getByText('SoC')).toBeTruthy()
    expect(rows(battery)).toEqual(['Pojemność nominalna: 10,0 kWh'])
    expect(within(battery).getByText('Energia w magazynie (szacunek)')).toBeTruthy()
    expect(battery.textContent).toContain('5,0 kWh z 10,0 kWh')
    unmount()

    render(<SiteDetailsPanels now={NOW} live={ready([['battery_soc']], [reading('battery_soc', 50)])} />)
    expect(screen.queryByText('Energia w magazynie (szacunek)')).toBeNull()
  })

  it('BMS: rozrzut napięć ogniw tylko z obu wartości, oznaczony jako wyliczony', () => {
    render(
      <SiteDetailsPanels
        now={NOW}
        live={ready(
          [['battery_cell_voltage_min'], ['battery_cell_voltage_max'], ['battery_cycle_count']],
          [reading('battery_cell_voltage_min', 3.31), reading('battery_cell_voltage_max', 3.342), reading('battery_cycle_count', 412)],
        )}
      />,
    )
    const bms = screen.getByRole('region', { name: 'BMS — ogniwa' })
    expect(rows(bms)).toEqual([
      'Napięcie ogniwa min.: 3,310 V',
      'Napięcie ogniwa maks.: 3,342 V',
      'Liczba cykli: 412',
      'Różnica napięć ogniw: 0,032 Vwyliczona: maks. − min.',
    ])
  })

  it('sieć: tabela faz z napięciem i prądem oraz energia dziś z API energii', () => {
    render(
      <SiteDetailsPanels
        now={NOW}
        today={{ status: 'ready', data: ENERGY }}
        live={ready(
          [['grid_voltage', 1], ['grid_current', 1], ['grid_voltage', 2], ['grid_current', 2]],
          [reading('grid_voltage', 230.2, 1), reading('grid_current', 3.4, 1), reading('grid_voltage', 231, 2)],
        )}
      />,
    )
    const grid = screen.getByRole('region', { name: 'Sieć' })
    expect(within(grid).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Faza', 'Napięcie', 'Prąd'])
    expect(within(grid).getAllByRole('row').slice(1).map((r) => r.textContent)).toEqual([
      'L1230,2 V3,4 A',
      'L2231,0 V—brak danych',
    ])
    expect(rows(grid)).toEqual(['Pobrane dziś: 4,2 kWhod północy', 'Oddane dziś: brak danychod północy'])
  })

  it('bilans dnia: samowystarczalność w pierścieniu i energia od północy, SIMULATED', () => {
    render(<SiteDetailsPanels now={NOW} today={{ status: 'ready', data: ENERGY }} live={ready([], [])} />)
    const balance = screen.getByRole('region', { name: 'Zużycie i samowystarczalność' })
    expect(balance.textContent).toContain('81%')
    expect(rows(balance)).toEqual([
      'Produkcja PV: 28,4 kWh',
      'Zużycie domu: 22,7 kWh',
      'Pobrane z sieci: 4,2 kWh',
      'Oddane do sieci: brak danych',
    ])
    expect(within(balance).getByText('SIMULATED')).toBeTruthy()
  })
})

function series(key: SiteEnergy['series'][number]['key'], totalWh: number | null): SiteEnergy['series'][number] {
  return { key, metric: key, deviceId: DEV, source: 'POWER', totalWh, coverage: 1, resetDetected: false, buckets: [] }
}

const KPI = { status: 'OK' as const, reason: null, coverage: 1, definition: 'Samowystarczalność = (zużycie − pobór) / zużycie' }

const ENERGY: SiteEnergy = {
  timezone: 'Europe/Warsaw',
  bucket: '1h',
  origins: ['SIMULATED'],
  series: [series('pv', 28_400), series('load', 22_700), series('grid_import', 4200), series('grid_export', null)],
  unavailable: [],
  kpis: { selfConsumption: { ...KPI, value: 0.6 }, selfSufficiency: { ...KPI, value: 0.81 } },
}
