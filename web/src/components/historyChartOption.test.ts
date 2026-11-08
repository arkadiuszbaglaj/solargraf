import { describe, expect, it } from 'vitest'
import type { History } from '../api/history'
import { parseHistory } from '../api/history'
import { axisFormat, buildHistoryOption, chartData, formatValue, hasValues, tooltipLines } from './historyChartOption'

const RAW = {
  metric: 'pv_power',
  channel: null,
  unit: 'W',
  cumulative: false,
  resolution: '5m',
  timezone: 'Europe/Warsaw',
  origins: ['SIMULATED'],
  points: [
    { t: '2026-11-07T10:00:00Z', value: 1500, min: 1000, max: 2000, coverage: 0.4 },
    { t: '2026-11-07T10:05:00Z', value: null, min: null, max: null, coverage: 0 },
    { t: '2026-11-07T10:10:00Z', value: 0, min: 0, max: 0, coverage: 1 },
  ],
}
const HISTORY = parseHistory(RAW) as History
const COLORS = { line: '#000', text: '#111', border: '#222' }
const SPAN_START = Date.parse('2026-11-01T00:00:00Z')
const span = (days: number) => ({ from: new Date(SPAN_START), to: new Date(SPAN_START + days * 86_400_000) })

describe('api/history', () => {
  it('waliduje odpowiedź', () => {
    expect(HISTORY.points).toHaveLength(3)
    expect(parseHistory({ ...RAW, resolution: '1w' })).toBeNull()
    expect(parseHistory({ ...RAW, points: [{ t: 'x', value: 1 }] })).toBeNull()
    expect(parseHistory({ ...RAW, points: [{ t: RAW.points[0]?.t, value: '1' }] })).toBeNull()
    expect(parseHistory({ ...RAW, origins: [1] })).toBeNull()
  })
})

describe('wykres historii (D47)', () => {
  it('luka to null, zero to wartość; moc w kW', () => {
    expect(chartData(HISTORY).map(([, v]) => v)).toEqual([1.5, null, 0])
    expect(hasValues(HISTORY)).toBe(true)
    expect(hasValues({ ...HISTORY, points: [{ t: RAW.points[0]?.t ?? '', value: null, min: null, max: null, coverage: 0 }] })).toBe(false)
  })

  it('formatuje jednostki prezentacji', () => {
    expect(formatValue(1500, 'W')).toBe('1,50 kW')
    expect(formatValue(123456, 'Wh')).toBe('123,5 kWh')
    expect(formatValue(230.04, 'V')).toBe('230,0 V')
    expect(formatValue(null, 'W')).toBe('—')
    expect(formatValue(25, 'degC')).toBe('25,0 °C')
    expect(formatValue(312, 'count')).toBe('312')
  })

  it('podpowiedź pokazuje min, max i pokrycie', () => {
    const lines = tooltipLines(HISTORY, 0, 'Europe/Warsaw')
    expect(lines[1]).toBe('Średnia: 1,50 kW')
    expect(lines[2]).toBe('Min: 1,00 kW, max: 2,00 kW')
    expect(lines[3]).toBe('Pokrycie danymi: 40%')
    expect(tooltipLines(HISTORY, 1, 'Europe/Warsaw')[1]).toBe('Średnia: —')
    const counter = tooltipLines({ ...HISTORY, cumulative: true }, 0, 'Europe/Warsaw')
    expect(counter[1]).toBe('Stan licznika: 1,50 kW')
    expect(counter.some((l) => l.startsWith('Min'))).toBe(false)
  })

  it('opcje: oś czasu w zakresie, bez łączenia luk', () => {
    const from = new Date('2026-11-06T23:00:00Z')
    const to = new Date('2026-11-07T23:00:00Z')
    const option = buildHistoryOption(HISTORY, COLORS, 'Europe/Warsaw', { from, to }) as {
      xAxis: { min: number; max: number }
      yAxis: { name: string }
      series: Array<{ connectNulls: boolean }>
    }
    expect([option.xAxis.min, option.xAxis.max]).toEqual([from.getTime(), to.getTime()])
    expect(option.yAxis.name).toBe('kW')
    expect(option.series[0]?.connectNulls).toBe(false)
  })

  it('etykiety osi zależą od długości zakresu', () => {
    const at = new Date('2026-11-07T11:00:00Z')
    expect(axisFormat(span(1), 'Europe/Warsaw').format(at)).toBe('12:00')
    expect(axisFormat(span(30), 'Europe/Warsaw').format(at)).toBe('07.11')
    expect(axisFormat(span(365), 'Europe/Warsaw').format(at)).toBe('lis')
  })
})
