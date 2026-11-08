import type { LoadedSeries, SeriesColor } from '../lib/siteHistory'
import { axisFormat, chartData, displayUnit, formatValue } from './historyChartOption'

export interface SiteChartColors {
  series: Record<SeriesColor, string>
  text: string
  border: string
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

const AXIS_NUMBER = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 2 })

/** Punkt podpowiedzi z ECharts: indeks serii i punktu. */
function indices(param: unknown): { series: number; point: number } | null {
  if (typeof param !== 'object' || param === null) return null
  if (!('seriesIndex' in param) || !('dataIndex' in param)) return null
  return { series: Number(param.seriesIndex), point: Number(param.dataIndex) }
}

/**
 * Treść podpowiedzi (D66): czas lokalny przedziału i dla każdej serii wartość albo „brak danych”
 * (nigdy 0) z pokryciem, gdy niepełne.
 */
export function siteTooltipLines(series: readonly LoadedSeries[], params: readonly unknown[], timeZone: string): string[] {
  const lines: string[] = []
  for (const param of params) {
    const idx = indices(param)
    const s = idx ? series[idx.series] : undefined
    const p = idx && s ? s.history.points[idx.point] : undefined
    if (!s || !p) continue
    if (lines.length === 0) {
      lines.push(
        new Intl.DateTimeFormat('pl-PL', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(p.t)),
      )
    }
    const value = p.value === null ? 'brak danych' : formatValue(p.value, s.history.unit)
    const partial = p.value !== null && p.coverage !== null && p.coverage < 1
    lines.push(`${s.name}: ${value}${partial ? ` (pokrycie ${Math.round((p.coverage ?? 0) * 100)}%)` : ''}`)
  }
  return lines
}

/**
 * Opcje ECharts dla kilku serii w jednej jednostce (moc w kW albo SoC w %).
 * Luki: `connectNulls: false` — przerwa w linii zamiast zera lub interpolacji.
 */
export function buildSiteHistoryOption(
  series: readonly LoadedSeries[],
  colors: SiteChartColors,
  timeZone: string,
  range: { from: Date; to: Date },
): Record<string, unknown> {
  const fmt = axisFormat(range, timeZone)
  const unit = series[0] ? displayUnit(series[0].history.unit).unit : ''
  return {
    aria: { enabled: true },
    animation: false,
    grid: { left: 56, right: 16, top: 24, bottom: series.length > 1 ? 64 : 32 },
    // Legenda w jednym wierszu (przewijana) — na wąskim ekranie nie nachodzi na oś czasu.
    legend:
      series.length > 1
        ? { type: 'scroll', bottom: 0, textStyle: { color: colors.text }, pageTextStyle: { color: colors.text } }
        : undefined,
    tooltip: {
      trigger: 'axis',
      formatter: (params: unknown) =>
        siteTooltipLines(series, Array.isArray(params) ? params : [params], timeZone)
          .map(escapeHtml)
          .join('<br>'),
    },
    xAxis: {
      type: 'time',
      min: range.from.getTime(),
      max: range.to.getTime(),
      axisLabel: { color: colors.text, hideOverlap: true, formatter: (v: number) => fmt.format(new Date(v)) },
      axisLine: { lineStyle: { color: colors.border } },
    },
    yAxis: {
      type: 'value',
      name: unit,
      ...(unit === '%' ? { min: 0, max: 100 } : {}),
      nameTextStyle: { color: colors.text },
      axisLabel: { color: colors.text, formatter: (v: number) => AXIS_NUMBER.format(v) },
      splitLine: { lineStyle: { color: colors.border } },
    },
    series: series.map((s) => ({
      type: 'line',
      name: s.name,
      showSymbol: s.history.resolution === '1d',
      connectNulls: false,
      lineStyle: { width: 2, color: colors.series[s.color] },
      itemStyle: { color: colors.series[s.color] },
      data: chartData(s.history),
    })),
  }
}
