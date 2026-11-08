import { describe, expect, it } from 'vitest'
import { parseHistory } from '../api/history'
import { POWER_SERIES, SOC_SERIES, type LoadedSeries, type SeriesDef } from '../lib/siteHistory'
import { history } from '../test/siteHistoryFixture'
import { buildSiteHistoryOption, siteTooltipLines } from './siteHistoryOption'

const TZ = 'Europe/Warsaw'
const RANGE = { from: new Date('2026-11-06T23:00:00Z'), to: new Date('2026-11-07T23:00:00Z') }
const COLORS = { series: { pv: 'g', home: 'h', grid: 'b', battery: 'v' }, text: 't', border: 'x' }

function loaded(def: SeriesDef, values: Array<number | null>): LoadedSeries {
  const h = parseHistory(history(def.metric, values))
  if (!h) throw new Error('fixture')
  return { ...def, history: h }
}

const [PV, LOAD] = POWER_SERIES as [SeriesDef, SeriesDef]

describe('buildSiteHistoryOption (D66)', () => {
  it('luki jako null w kW, bez łączenia linii', () => {
    const option = buildSiteHistoryOption([loaded(PV, [1500, null])], COLORS, TZ, RANGE) as {
      series: Array<{ connectNulls: boolean; data: Array<[number, number | null]>; lineStyle: { color: string } }>
      yAxis: { name: string }
      legend: unknown
    }
    expect(option.yAxis.name).toBe('kW')
    expect(option.legend).toBeUndefined()
    expect(option.series[0]?.connectNulls).toBe(false)
    expect(option.series[0]?.data.map(([, v]) => v)).toEqual([1.5, null])
    expect(option.series[0]?.lineStyle.color).toBe('g')
  })

  it('kilka serii ma legendę; SoC ma oś 0–100 %', () => {
    const power = buildSiteHistoryOption([loaded(PV, [1]), loaded(LOAD, [2])], COLORS, TZ, RANGE) as {
      legend: unknown
    }
    expect(power.legend).toBeDefined()
    const soc = buildSiteHistoryOption([loaded(SOC_SERIES, [55])], COLORS, TZ, RANGE) as {
      yAxis: { name: string; min: number; max: number }
    }
    expect(soc.yAxis).toMatchObject({ name: '%', min: 0, max: 100 })
  })

  it('podpowiedź: czas lokalny, „brak danych” zamiast 0, niepełne pokrycie', () => {
    const pv = loaded(PV, [1500, null])
    const load = loaded(LOAD, [800, 900])
    const first = load.history.points[0]
    if (first) first.coverage = 0.5
    const lines = siteTooltipLines(
      [pv, load],
      [
        { seriesIndex: 0, dataIndex: 1 },
        { seriesIndex: 1, dataIndex: 0 },
      ],
      TZ,
    )
    expect(lines[0]).toContain('00:05')
    expect(lines[1]).toBe('Produkcja PV: brak danych')
    expect(lines[2]).toBe('Zużycie domu: 0,80 kW (pokrycie 50%)')
  })
})
