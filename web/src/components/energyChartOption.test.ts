import { describe, expect, it } from 'vitest'
import type { EnergyChart } from '../data/types'
import { buildChartOption, buildSeries } from './energyChartOption'

const COLORS = { pv: 'g', home: 'h', grid: 'b', text: 't', border: 'x' }

const CHART: EnergyChart = {
  origin: 'DEMO',
  localDate: '2026-11-07',
  unit: 'W',
  pv: [
    ['2026-11-06T23:00:00.000Z', 0],
    ['2026-11-07T12:00:00.000Z', null],
    ['2026-11-07T12:05:00.000Z', 2500],
  ],
  home: [['2026-11-06T23:00:00.000Z', 400]],
  gridImport: [['2026-11-06T23:00:00.000Z', 400]],
}

describe('opcje wykresu', () => {
  it('konwertuje W na kW i zachowuje luki jako null (nie 0)', () => {
    const pv = buildSeries(CHART, COLORS)[0]
    expect(pv?.data).toEqual([
      [Date.parse('2026-11-06T23:00:00.000Z'), 0],
      [Date.parse('2026-11-07T12:00:00.000Z'), null],
      [Date.parse('2026-11-07T12:05:00.000Z'), 2.5],
    ])
  })

  it('nie łączy punktów przez luki i ma włączone aria', () => {
    const option = buildChartOption(CHART, COLORS, 'Europe/Warsaw') as {
      aria: { enabled: boolean }
      series: Array<{ connectNulls: boolean }>
      xAxis: { min: number; max: number }
    }
    expect(option.aria.enabled).toBe(true)
    expect(option.series.every((s) => s.connectNulls === false)).toBe(true)
    expect(option.xAxis.max - option.xAxis.min).toBe(24 * 3_600_000)
  })

  it('legenda w jednym przewijanym wierszu — na telefonie nie nachodzi na oś czasu', () => {
    const option = buildChartOption(CHART, COLORS, 'Europe/Warsaw') as { legend: { type: string; bottom: number } }
    expect(option.legend).toMatchObject({ type: 'scroll', bottom: 0 })
  })
})
