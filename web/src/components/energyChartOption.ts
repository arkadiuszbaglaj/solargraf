import type { EnergyChart, SeriesPoint } from '../data/types'
import { wattsToKilowatts } from '../lib/format'

export interface ChartColors {
  pv: string
  home: string
  grid: string
  text: string
  border: string
}

export interface ChartSeries {
  name: string
  color: string
  /** [czas ms, kW lub null] — null przerywa linię (luka), nie jest zerem. */
  data: Array<[number, number | null]>
}

function toKw(points: SeriesPoint[]): Array<[number, number | null]> {
  return points.map(([iso, w]) => [Date.parse(iso), w === null ? null : wattsToKilowatts(w)])
}

export function buildSeries(chart: EnergyChart, colors: ChartColors): ChartSeries[] {
  return [
    { name: 'Produkcja PV', color: colors.pv, data: toKw(chart.pv) },
    { name: 'Zużycie domu', color: colors.home, data: toKw(chart.home) },
    { name: chart.gridLabel ?? 'Pobór z sieci', color: colors.grid, data: toKw(chart.gridImport) },
  ]
}

/** Opcje ECharts. Luki: `connectNulls: false` — brak linii zamiast zera lub interpolacji. */
export function buildChartOption(
  chart: EnergyChart,
  colors: ChartColors,
  timeZone: string,
): Record<string, unknown> {
  const fmt = new Intl.DateTimeFormat('pl-PL', { timeZone, hour: '2-digit', minute: '2-digit' })
  const dayStart = chart.pv[0] ? Date.parse(chart.pv[0][0]) : undefined
  return {
    aria: { enabled: true },
    animation: false,
    grid: { left: 48, right: 16, top: 16, bottom: 56 },
    legend: { bottom: 0, textStyle: { color: colors.text } },
    tooltip: {
      trigger: 'axis',
      valueFormatter: (v: unknown) =>
        typeof v === 'number' ? `${v.toFixed(2).replace('.', ',')} kW` : 'brak danych',
    },
    xAxis: {
      type: 'time',
      min: dayStart,
      max: dayStart === undefined ? undefined : dayStart + 24 * 3_600_000,
      axisLabel: { color: colors.text, formatter: (v: number) => fmt.format(new Date(v)) },
      axisLine: { lineStyle: { color: colors.border } },
    },
    yAxis: {
      type: 'value',
      name: 'kW',
      nameTextStyle: { color: colors.text },
      axisLabel: { color: colors.text },
      splitLine: { lineStyle: { color: colors.border } },
    },
    series: buildSeries(chart, colors).map((s) => ({
      name: s.name,
      type: 'line',
      showSymbol: false,
      connectNulls: false,
      lineStyle: { width: 2, color: s.color },
      itemStyle: { color: s.color },
      data: s.data,
    })),
  }
}
