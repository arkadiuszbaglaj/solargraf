/**
 * Teksty „dziś” w kartach (D51) z energii instalacji. Brak danych nigdy nie jest „0 kWh”.
 */
import type { EnergyKey, Kpi, SiteEnergy } from '../api/energy'
import { formatQuantity, MISSING } from './format'

/** Poniżej tego pokrycia doby wartość jest oznaczona jako niepełna (jak `COMPLETE_COVERAGE` w D48). */
export const COMPLETE_COVERAGE = 0.95

export type TodayState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: SiteEnergy }

export function todayEnergy(today: TodayState | undefined, key: EnergyKey): string {
  if (!today || today.status === 'loading') return '…'
  if (today.status === 'error') return 'brak danych'
  const series = today.data.series.find((s) => s.key === key)
  if (!series) {
    const missing = today.data.unavailable.find((u) => u.key === key)
    return missing?.reason === 'AMBIGUOUS' ? `wiele źródeł (${missing.sources})` : 'niedostępne'
  }
  if (series.totalWh === null) return 'brak danych'
  const incomplete = series.coverage < COMPLETE_COVERAGE || series.resetDetected
  return `${formatQuantity(series.totalWh, 'Wh')}${incomplete ? ' (niepełne)' : ''}`
}

export interface KpiView {
  value: string
  unavailableReason: string | null
  notice: string | null
}

export function kpiView(kpi: Kpi): KpiView {
  const percent = kpi.value === null ? MISSING : formatQuantity(kpi.value * 100, '%')
  switch (kpi.status) {
    case 'OK':
      return { value: percent, unavailableReason: null, notice: null }
    case 'INCOMPLETE':
      return {
        value: percent,
        unavailableReason: null,
        notice: `Dane niepełne (pokrycie ${formatQuantity(kpi.coverage * 100, '%')})`,
      }
    case 'INCONSISTENT':
      return { value: MISSING, unavailableReason: null, notice: 'Pomiary niespójne — wynik poza 0–100%' }
    case 'UNAVAILABLE':
      return { value: MISSING, unavailableReason: kpi.reason ?? 'Niedostępne', notice: null }
  }
}
