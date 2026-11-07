import type { History, HistoryResolution } from '../api/history'
import { MISSING } from '../lib/format'

export interface HistoryColors {
  line: string
  text: string
  border: string
}

/** Jednostka prezentacji (D47): moc w kW, energia w kWh, pozostałe bez zmian. */
export function displayUnit(unit: string): { unit: string; factor: number; digits: number } {
  if (unit === 'W') return { unit: 'kW', factor: 1 / 1000, digits: 2 }
  if (unit === 'Wh') return { unit: 'kWh', factor: 1 / 1000, digits: 1 }
  if (unit === 'Hz') return { unit, factor: 1, digits: 2 }
  if (unit === '%') return { unit, factor: 1, digits: 0 }
  return { unit, factor: 1, digits: 1 }
}

export function formatValue(value: number | null, unit: string): string {
  if (value === null || !Number.isFinite(value)) return MISSING
  const d = displayUnit(unit)
  const text = new Intl.NumberFormat('pl-PL', {
    minimumFractionDigits: d.digits,
    maximumFractionDigits: d.digits,
  }).format(value * d.factor)
  return d.unit === '%' ? `${text}%` : `${text} ${d.unit}`
}

export const RESOLUTION_LABEL: Record<HistoryResolution, string> = {
  raw: 'surowe odczyty',
  '5m': '5 min',
  '1h': '1 h',
  '1d': '1 doba',
}

/** Punkty wykresu: [czas ms, wartość w jednostce prezentacji albo null — luka, nie zero]. */
export function chartData(history: History): Array<[number, number | null]> {
  const { factor } = displayUnit(history.unit)
  return history.points.map((p) => [Date.parse(p.t), p.value === null ? null : p.value * factor])
}

export function hasValues(history: History): boolean {
  return history.points.some((p) => p.value !== null)
}

/** Format etykiet osi według długości zakresu (nie rozdzielczości): godziny, dni albo miesiące. */
export function axisFormat(range: { from: Date; to: Date }, timeZone: string): Intl.DateTimeFormat {
  const days = (range.to.getTime() - range.from.getTime()) / 86_400_000
  if (days <= 1.1) return new Intl.DateTimeFormat('pl-PL', { timeZone, hour: '2-digit', minute: '2-digit' })
  if (days <= 32) return new Intl.DateTimeFormat('pl-PL', { timeZone, day: '2-digit', month: '2-digit' })
  return new Intl.DateTimeFormat('pl-PL', { timeZone, month: 'short' })
}

/** Treść podpowiedzi dla punktu: czas lokalny, wartość, min/max i pokrycie. */
export function tooltipLines(history: History, index: number, timeZone: string): string[] {
  const p = history.points[index]
  if (!p) return []
  const when = new Intl.DateTimeFormat('pl-PL', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(p.t),
  )
  const lines = [when, `${history.cumulative ? 'Stan licznika' : 'Średnia'}: ${formatValue(p.value, history.unit)}`]
  if (p.value !== null && p.min !== null && p.max !== null && !history.cumulative) {
    lines.push(`Min: ${formatValue(p.min, history.unit)}, max: ${formatValue(p.max, history.unit)}`)
  }
  if (p.coverage !== null) lines.push(`Pokrycie danymi: ${Math.round(p.coverage * 100)}%`)
  return lines
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

const AXIS_NUMBER = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 2 })

/** Opcje ECharts. Luki: `connectNulls: false` — przerwa w linii zamiast zera lub interpolacji. */
export function buildHistoryOption(
  history: History,
  colors: HistoryColors,
  timeZone: string,
  range: { from: Date; to: Date },
): Record<string, unknown> {
  const fmt = axisFormat(range, timeZone)
  const unit = displayUnit(history.unit).unit
  return {
    aria: { enabled: true },
    animation: false,
    grid: { left: 56, right: 16, top: 24, bottom: 32 },
    tooltip: {
      trigger: 'axis',
      formatter: (params: unknown) => {
        const first: unknown = Array.isArray(params) ? params[0] : params
        const index =
          typeof first === 'object' && first !== null && 'dataIndex' in first ? Number(first.dataIndex) : -1
        return tooltipLines(history, index, timeZone).map(escapeHtml).join('<br>')
      },
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
      scale: history.cumulative,
      nameTextStyle: { color: colors.text },
      axisLabel: { color: colors.text, formatter: (v: number) => AXIS_NUMBER.format(v) },
      splitLine: { lineStyle: { color: colors.border } },
    },
    series: [
      {
        type: 'line',
        name: history.metric,
        showSymbol: history.resolution === '1d',
        connectNulls: false,
        step: false,
        lineStyle: { width: 2, color: colors.line },
        itemStyle: { color: colors.line },
        data: chartData(history),
      },
    ],
  }
}
