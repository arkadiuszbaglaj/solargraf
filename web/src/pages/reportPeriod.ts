/** Okres raportu (D74): bieżący miesiąc w strefie instalacji, krok i etykiety. */
import type { EnergyBucketSize } from '../api/energy'
import type { ReportSelection } from '../api/reports'

/** Rok i miesiąc (1–12) chwili `now` w strefie `timeZone`. */
export function localYearMonth(now: Date, timeZone: string): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric' }).formatToParts(now)
  const pick = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  return { year: pick('year'), month: pick('month') }
}

/** Poprzedni (-1) albo następny (+1) okres tego samego rodzaju. */
export function shift(selection: ReportSelection, step: -1 | 1): ReportSelection {
  if (selection.month === null) return { year: selection.year + step, month: null }
  const index = selection.year * 12 + (selection.month - 1) + step
  return { year: Math.floor(index / 12), month: (index % 12) + 1 }
}

/** Okres zawiera chwilę `now` (albo jest późniejszy) — następnego jeszcze nie ma. */
export function isCurrentOrLater(selection: ReportSelection, now: Date, timeZone: string): boolean {
  const current = localYearMonth(now, timeZone)
  if (selection.year !== current.year) return selection.year > current.year
  return selection.month === null || selection.month >= current.month
}

const MONTH = new Intl.DateTimeFormat('pl-PL', { month: 'long', timeZone: 'UTC' })

/** Nazwa okresu, np. „listopad 2026” albo „rok 2026”. */
export function periodLabel(selection: ReportSelection): string {
  if (selection.month === null) return `rok ${selection.year}`
  return `${MONTH.format(new Date(Date.UTC(selection.year, selection.month - 1, 15)))} ${selection.year}`
}

/** Etykieta wiersza tabeli: dzień z dniem tygodnia albo nazwa miesiąca, w strefie instalacji. */
export function bucketLabel(iso: string, bucket: EnergyBucketSize, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions =
    bucket === '1mo' ? { timeZone, month: 'long' } : { timeZone, weekday: 'short', day: '2-digit', month: '2-digit' }
  return new Intl.DateTimeFormat('pl-PL', options).format(new Date(iso))
}
