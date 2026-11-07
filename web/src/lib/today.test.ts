import { describe, expect, it } from 'vitest'
import { parseSiteEnergy, type Kpi } from '../api/energy'
import { ENERGY_BODY, KPI } from '../test/energyFixture'
import { kpiView, todayEnergy, type TodayState } from './today'

const SITE_BODY = {
  ...ENERGY_BODY,
  series: [
    { ...ENERGY_BODY.series[0], device_id: 'dev-1', total_wh: 12_400, coverage: 1, reset_detected: false },
    { ...ENERGY_BODY.series[0], key: 'load', metric: 'load_power', source: 'POWER', device_id: 'dev-1', total_wh: 9_000, coverage: 0.5, reset_detected: false },
    { ...ENERGY_BODY.series[0], key: 'grid_import', metric: 'grid_import_energy_total', device_id: 'dev-2', total_wh: null, coverage: 0, reset_detected: false },
  ],
  unavailable: [
    { key: 'grid_export', metric: 'grid_export_energy_total', reason: 'AMBIGUOUS', sources: 2 },
    { key: 'battery_charge', metric: 'battery_charge_energy_total', reason: 'NOT_PROVIDED', sources: 0 },
  ],
}

function ready(): TodayState {
  const data = parseSiteEnergy(SITE_BODY)
  if (!data) throw new Error('fixture')
  return { status: 'ready', data }
}

describe('todayEnergy', () => {
  it('pokazuje energię, niepełne pokrycie, brak danych i powód niedostępności', () => {
    const today = ready()
    expect(todayEnergy(today, 'pv')).toBe('12,4 kWh')
    expect(todayEnergy(today, 'load')).toBe('9,0 kWh (niepełne)')
    expect(todayEnergy(today, 'grid_import')).toBe('brak danych') // nigdy „0 kWh”
    expect(todayEnergy(today, 'grid_export')).toBe('wiele źródeł (2)')
    expect(todayEnergy(today, 'battery_charge')).toBe('niedostępne')
  })

  it('ładowanie i błąd pobrania', () => {
    expect(todayEnergy({ status: 'loading' }, 'pv')).toBe('…')
    expect(todayEnergy({ status: 'error' }, 'pv')).toBe('brak danych')
    expect(todayEnergy(undefined, 'pv')).toBe('…')
  })

  it('parser energii instalacji odrzuca nieznany powód niedostępności', () => {
    expect(parseSiteEnergy({ ...SITE_BODY, unavailable: [{ key: 'pv', metric: 'x', reason: 'OTHER', sources: 0 }] })).toBeNull()
    expect(parseSiteEnergy(ENERGY_BODY)).toBeNull() // brak listy `unavailable`
  })
})

const kpi = (over: Partial<Kpi>): Kpi => ({ ...(KPI as Kpi), ...over })

describe('kpiView', () => {
  it('statusy D48', () => {
    expect(kpiView(kpi({ value: 0.944, status: 'OK' }))).toEqual({ value: '94%', unavailableReason: null, notice: null })
    expect(kpiView(kpi({ value: 0.5, status: 'INCOMPLETE', coverage: 0.6 })).notice).toBe('Dane niepełne (pokrycie 60%)')
    expect(kpiView(kpi({ value: null, status: 'INCONSISTENT' })).value).toBe('—')
    expect(kpiView(kpi({ value: null, status: 'UNAVAILABLE', reason: 'Brak liczników.' }))).toEqual({
      value: '—',
      unavailableReason: 'Brak liczników.',
      notice: null,
    })
  })
})
