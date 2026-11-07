import type { Energy, EnergyBucketSize, EnergyKey, Kpi } from '../api/energy'
import { MISSING, wattHoursToKilowattHours } from '../lib/format'

export const ENERGY_LABEL: Record<EnergyKey, string> = {
  pv: 'Produkcja PV',
  load: 'Zużycie domu',
  grid_import: 'Pobór z sieci',
  grid_export: 'Eksport do sieci',
  battery_charge: 'Ładowanie baterii',
  battery_discharge: 'Rozładowanie baterii',
}

export interface EnergyColors {
  pv: string
  home: string
  grid: string
  export: string
  battery: string
  text: string
  border: string
}

const NUMBER = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const PERCENT = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 1 })

/** Energia w kWh (1 miejsce po przecinku); brak wartości to „—”, nigdy 0. */
export function formatKwh(wh: number | null): string {
  return wh === null ? MISSING : `${NUMBER.format(wattHoursToKilowattHours(wh))} kWh`
}

export function formatPercent(ratio: number): string {
  return `${PERCENT.format(ratio * 100)}%`
}

/** Tekst kafelka wskaźnika: wartość tylko dla OK i INCOMPLETE (D48). */
export function kpiText(kpi: Kpi): { value: string; note: string | null } {
  if (kpi.value === null || kpi.status === 'UNAVAILABLE' || kpi.status === 'INCONSISTENT') {
    return {
      value: MISSING,
      note: kpi.reason ?? (kpi.status === 'INCONSISTENT' ? 'Pomiary są ze sobą niespójne.' : 'Wskaźnik niedostępny.'),
    }
  }
  if (kpi.status === 'INCOMPLETE') {
    return {
      value: formatPercent(kpi.value),
      note: `${kpi.reason ?? 'Niepełne dane.'} Pokrycie danymi: ${Math.round(kpi.coverage * 100)}%.`,
    }
  }
  return { value: formatPercent(kpi.value), note: null }
}

function color(key: EnergyKey, c: EnergyColors): string {
  switch (key) {
    case 'pv':
      return c.pv
    case 'load':
      return c.home
    case 'grid_import':
      return c.grid
    case 'grid_export':
      return c.export
    case 'battery_charge':
    case 'battery_discharge':
      return c.battery
  }
}

function axisFormat(bucket: EnergyBucketSize, timeZone: string): Intl.DateTimeFormat {
  if (bucket === '1h') return new Intl.DateTimeFormat('pl-PL', { timeZone, hour: '2-digit', minute: '2-digit' })
  if (bucket === '1d') return new Intl.DateTimeFormat('pl-PL', { timeZone, day: '2-digit', month: '2-digit' })
  return new Intl.DateTimeFormat('pl-PL', { timeZone, month: 'short' })
}

/** Kategorie osi (początki przedziałów) i słupki kWh; `null` to brak słupka, nie zero. */
export function barData(energy: Energy): { categories: string[]; series: Array<{ key: EnergyKey; values: Array<number | null> }> } {
  const categories = energy.series[0]?.buckets.map((b) => b.t) ?? []
  return {
    categories,
    series: energy.series.map((s) => ({
      key: s.key,
      values: s.buckets.map((b) => (b.wh === null ? null : wattHoursToKilowattHours(b.wh))),
    })),
  }
}

const AXIS_NUMBER = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 2 })

export function buildEnergyOption(energy: Energy, colors: EnergyColors, timeZone: string): Record<string, unknown> {
  const fmt = axisFormat(energy.bucket, timeZone)
  const { categories, series } = barData(energy)
  return {
    aria: { enabled: true },
    animation: false,
    grid: { left: 56, right: 16, top: 24, bottom: 64 },
    legend: { bottom: 0, textStyle: { color: colors.text } },
    tooltip: {
      trigger: 'axis',
      valueFormatter: (v: unknown) =>
        typeof v === 'number' ? `${NUMBER.format(v)} kWh` : 'brak danych',
    },
    xAxis: {
      type: 'category',
      data: categories.map((t) => fmt.format(new Date(t))),
      axisLabel: { color: colors.text, hideOverlap: true },
      axisLine: { lineStyle: { color: colors.border } },
    },
    yAxis: {
      type: 'value',
      name: 'kWh',
      nameTextStyle: { color: colors.text },
      axisLabel: { color: colors.text, formatter: (v: number) => AXIS_NUMBER.format(v) },
      splitLine: { lineStyle: { color: colors.border } },
    },
    series: series.map((s) => ({
      type: 'bar',
      name: ENERGY_LABEL[s.key],
      itemStyle: { color: color(s.key, colors), opacity: s.key === 'battery_discharge' ? 0.55 : 1 },
      data: s.values,
    })),
  }
}
