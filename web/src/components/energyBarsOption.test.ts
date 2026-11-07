import { describe, expect, it } from 'vitest'
import type { Energy, Kpi } from '../api/energy'
import { parseEnergy } from '../api/energy'
import { ENERGY_BODY, KPI } from '../test/energyFixture'
import { barData, buildEnergyOption, formatKwh, kpiText } from './energyBarsOption'

const ENERGY = parseEnergy(ENERGY_BODY) as Energy
const COLORS = { pv: '#1', home: '#2', grid: '#3', export: '#4', battery: '#5', text: '#6', border: '#7' }
const kpi = (over: Partial<Kpi>): Kpi => ({ value: 0.5, status: 'OK', reason: null, coverage: 1, definition: 'd', ...over })

describe('api/energy', () => {
  it('waliduje odpowiedź', () => {
    expect(ENERGY.series[0]?.resetDetected).toBe(true)
    expect(ENERGY.kpis.selfSufficiency.status).toBe('UNAVAILABLE')
    expect(parseEnergy({ ...ENERGY_BODY, bucket: '1w' })).toBeNull()
    expect(parseEnergy({ ...ENERGY_BODY, series: [{ ...ENERGY_BODY.series[0], key: 'x' }] })).toBeNull()
    expect(parseEnergy({ ...ENERGY_BODY, kpis: { self_consumption: KPI } })).toBeNull()
  })
})

describe('energia i wskaźniki (D48)', () => {
  it('kWh z jednym miejscem, brak to „—”, zero to 0,0', () => {
    expect(formatKwh(28_400)).toBe('28,4 kWh')
    expect(formatKwh(0)).toBe('0,0 kWh')
    expect(formatKwh(null)).toBe('—')
  })

  it('kafelek: wartość tylko dla OK i niepełnych', () => {
    expect(kpiText(kpi({ value: 0.9437 }))).toEqual({ value: '94,4%', note: null })
    expect(kpiText(kpi({ status: 'INCOMPLETE', reason: 'Wykryto reset licznika.', coverage: 0.5 }))).toEqual({
      value: '50%',
      note: 'Wykryto reset licznika. Pokrycie danymi: 50%.',
    })
    expect(kpiText(kpi({ value: null, status: 'UNAVAILABLE', reason: 'Brak produkcji PV w tym okresie.' }))).toEqual({
      value: '—',
      note: 'Brak produkcji PV w tym okresie.',
    })
    expect(kpiText(kpi({ value: null, status: 'INCONSISTENT', reason: null })).value).toBe('—')
  })

  it('słupki: luka to null, zero to wartość', () => {
    const { categories, series } = barData(ENERGY)
    expect(categories).toHaveLength(3)
    expect(series[0]?.values).toEqual([0.5, null, 0])
    const option = buildEnergyOption(ENERGY, COLORS, 'Europe/Warsaw') as {
      xAxis: { data: string[] }
      series: Array<{ name: string; type: string }>
    }
    expect(option.xAxis.data).toEqual(['00:00', '01:00', '02:00'])
    expect(option.series[0]).toMatchObject({ name: 'Produkcja PV', type: 'bar' })
  })
})
