import { type Zoom, FULL_ZOOM, visibleRange } from '../lib/chartZoom'
import type { LoadedSeries, SeriesColor } from '../lib/siteHistory'
import { axisFormat, chartData, displayUnit, formatValue } from './historyChartOption'

export interface SiteChartColors {
  series: Record<SeriesColor, string>
  text: string
  border: string
  accent: string
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

/** Etykiety osi czasu dopasowane do widocznego fragmentu (po przybliżeniu tygodnia — godziny). */
export function zoomAxisLabel(
  range: { from: Date; to: Date },
  zoom: Zoom,
  timeZone: string,
): (v: number) => string {
  const fmt = axisFormat(visibleRange(range, zoom), timeZone)
  return (v: number) => fmt.format(new Date(v))
}

const HANDLE_LABEL = (timeZone: string) =>
  new Intl.DateTimeFormat('pl-PL', { timeZone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

/**
 * Opcje ECharts dla kilku serii w jednej jednostce (moc w kW albo SoC w %).
 * Luki: `connectNulls: false` — przerwa w linii zamiast zera lub interpolacji.
 * Przybliżenie: suwak pod wykresem (`slider`, opcjonalny) i `inside` — kółko myszy tylko z Ctrl,
 * by nie przejmować przewijania strony; przeciąganie zaznacza fragment (narzędzie dataZoom).
 */
export function buildSiteHistoryOption(
  series: readonly LoadedSeries[],
  colors: SiteChartColors,
  timeZone: string,
  range: { from: Date; to: Date },
  zoom: Zoom = FULL_ZOOM,
  slider = true,
): Record<string, unknown> {
  const unit = series[0] ? displayUnit(series[0].history.unit).unit : ''
  const legend = series.length > 1
  const sliderBottom = legend ? 30 : 6
  const handle = HANDLE_LABEL(timeZone)
  return {
    aria: { enabled: true },
    animation: false,
    grid: { left: 56, right: 16, top: 24, bottom: slider ? sliderBottom + 24 + 32 : legend ? 64 : 32 },
    // Narzędzie zaznaczania fragmentu bez widocznych ikon (pasek musi być włączony, by działało);
    // włącza je komponent (takeGlobalCursor), a przyciski strony zastępują ikony.
    toolbox: {
      show: true,
      itemSize: 0,
      showTitle: false,
      feature: { dataZoom: { yAxisIndex: 'none', icon: { zoom: 'path://M0,0', back: 'path://M0,0' } } },
    },
    dataZoom: [
      {
        type: 'inside',
        xAxisIndex: 0,
        filterMode: 'none',
        start: zoom.start,
        end: zoom.end,
        zoomOnMouseWheel: 'ctrl',
        moveOnMouseWheel: false,
        moveOnMouseMove: false,
      },
      ...(slider
        ? [
            {
              type: 'slider',
              xAxisIndex: 0,
              filterMode: 'none',
              start: zoom.start,
              end: zoom.end,
              bottom: sliderBottom,
              height: 22,
              borderColor: colors.border,
              fillerColor: 'rgba(127, 127, 127, 0.18)',
              handleStyle: { color: colors.accent, borderColor: colors.accent },
              moveHandleStyle: { color: colors.accent },
              textStyle: { color: colors.text },
              dataBackground: { lineStyle: { color: colors.border }, areaStyle: { color: colors.border } },
              labelFormatter: (v: number) => handle.format(new Date(v)),
            },
          ]
        : []),
    ],
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
      axisLabel: { color: colors.text, hideOverlap: true, formatter: zoomAxisLabel(range, zoom, timeZone) },
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
