import type { History } from '../api/history'
import { axisFormat, chartData } from './historyChartOption'

export interface StringChartColors {
  voltage: string
  current: string
  text: string
  border: string
}

const AXIS_NUMBER = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 1 })
const VALUE = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

/** Wartość punktu historii w podpowiedzi; brak — „brak danych”, nigdy 0. */
function pointText(history: History | null, index: number, unit: string): string {
  const v = history?.points[index]?.value
  return v === null || v === undefined ? 'brak danych' : `${VALUE.format(v)} ${unit}`
}

/** Seria linii na wskazanej osi; luki bez łączenia. */
const line = (name: string, history: History, color: string, yAxisIndex: number) => ({
  type: 'line',
  name,
  yAxisIndex,
  showSymbol: false,
  connectNulls: false,
  lineStyle: { width: 2, color },
  itemStyle: { color },
  data: chartData(history),
})

/**
 * Wykres napięcia [V, oś lewa] i prądu [A, oś prawa] stringu MPPT od północy (D69).
 * Luki: `connectNulls: false` — przerwa w linii zamiast zera. Seria bez źródła jest pomijana.
 */
export function buildStringOption(
  voltage: History | null,
  current: History | null,
  colors: StringChartColors,
  timeZone: string,
  range: { from: Date; to: Date },
): Record<string, unknown> {
  const fmt = axisFormat(range, timeZone)
  const time = new Intl.DateTimeFormat('pl-PL', { timeZone, hour: '2-digit', minute: '2-digit' })
  const axis = (name: string) => ({
    type: 'value',
    name,
    nameTextStyle: { color: colors.text },
    axisLabel: { color: colors.text, formatter: (v: number) => AXIS_NUMBER.format(v) },
    splitLine: { lineStyle: { color: colors.border } },
  })
  const series = [
    ...(voltage ? [line('Napięcie', voltage, colors.voltage, 0)] : []),
    ...(current ? [line('Prąd', current, colors.current, 1)] : []),
  ]
  return {
    aria: { enabled: true },
    animation: false,
    grid: { left: 48, right: 40, top: 28, bottom: 28 },
    legend: { show: false },
    tooltip: {
      trigger: 'axis',
      formatter: (params: unknown) => {
        const first: unknown = Array.isArray(params) ? params[0] : params
        const index =
          typeof first === 'object' && first !== null && 'dataIndex' in first ? Number(first.dataIndex) : -1
        const t = (voltage ?? current)?.points[index]?.t
        const lines = [
          t ? time.format(new Date(t)) : '',
          ...(voltage ? [`Napięcie: ${pointText(voltage, index, 'V')}`] : []),
          ...(current ? [`Prąd: ${pointText(current, index, 'A')}`] : []),
        ]
        return lines.map(escapeHtml).join('<br>')
      },
    },
    xAxis: {
      type: 'time',
      min: range.from.getTime(),
      max: range.to.getTime(),
      axisLabel: { color: colors.text, hideOverlap: true, formatter: (v: number) => fmt.format(new Date(v)) },
      axisLine: { lineStyle: { color: colors.border } },
    },
    yAxis: [axis('V'), { ...axis('A'), splitLine: { show: false } }],
    series,
  }
}
