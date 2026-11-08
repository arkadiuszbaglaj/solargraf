/**
 * Zakresy wykresu historii (D47): dzień, tydzień (od poniedziałku), miesiąc, rok — granice
 * o północy w strefie instalacji, także w dniach zmiany czasu.
 */
import { localDate, startOfLocalDay } from './time'

export type Period = 'day' | 'week' | 'month' | 'year'

export interface HistoryRange {
  from: Date
  to: Date
  label: string
}

/** Data kalendarzowa (bez strefy) jako [rok, miesiąc 1–12, dzień]. */
type Ymd = [number, number, number]

function parse(date: string): Ymd {
  const [y, m, d] = date.split('-').map(Number) as Ymd
  return [y, m, d]
}

function format([y, m, d]: Ymd): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function addDays([y, m, d]: Ymd, days: number): Ymd {
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()]
}

/** Północ danej daty w strefie instalacji (chwila UTC). */
export function localMidnight(date: Ymd, timeZone: string): Date {
  // Południe UTC tej daty leży w tej samej dobie lokalnej dla stref od -11 do +11 h.
  const [y, m, d] = date
  return startOfLocalDay(new Date(Date.UTC(y, m - 1, d, 12)), timeZone)
}

function periodStart(date: Ymd, period: Period): Ymd {
  const [y, m, d] = date
  switch (period) {
    case 'day':
      return date
    case 'week': {
      const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7 // pon = 0
      return addDays(date, -weekday)
    }
    case 'month':
      return [y, m, 1]
    case 'year':
      return [y, 1, 1]
  }
}

function periodEnd(start: Ymd, period: Period): Ymd {
  const [y, m] = start
  switch (period) {
    case 'day':
      return addDays(start, 1)
    case 'week':
      return addDays(start, 7)
    case 'month':
      return m === 12 ? [y + 1, 1, 1] : [y, m + 1, 1]
    case 'year':
      return [y + 1, 1, 1]
  }
}

const DATE = new Intl.DateTimeFormat('pl-PL', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' })
const SHORT = new Intl.DateTimeFormat('pl-PL', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' })
const MONTH = new Intl.DateTimeFormat('pl-PL', { timeZone: 'UTC', month: 'long', year: 'numeric' })

const utc = ([y, m, d]: Ymd) => new Date(Date.UTC(y, m - 1, d))

function label(start: Ymd, period: Period): string {
  switch (period) {
    case 'day':
      return DATE.format(utc(start))
    case 'week':
      return `${SHORT.format(utc(start))} – ${SHORT.format(utc(addDays(start, 6)))}`
    case 'month':
      return MONTH.format(utc(start))
    case 'year':
      return String(start[0])
  }
}

/** Zakres okresu, w którym leży data `anchor` (YYYY-MM-DD w strefie instalacji). */
export function rangeFor(anchor: string, period: Period, timeZone: string): HistoryRange {
  const start = periodStart(parse(anchor), period)
  return {
    from: localMidnight(start, timeZone),
    to: localMidnight(periodEnd(start, period), timeZone),
    label: label(start, period),
  }
}

/** Data w poprzednim (`-1`) albo następnym (`1`) okresie. */
export function shiftAnchor(anchor: string, period: Period, step: -1 | 1): string {
  const start = periodStart(parse(anchor), period)
  if (step === 1) return format(periodEnd(start, period))
  const [y, m] = start
  switch (period) {
    case 'day':
      return format(addDays(start, -1))
    case 'week':
      return format(addDays(start, -7))
    case 'month':
      return format(m === 1 ? [y - 1, 12, 1] : [y, m - 1, 1])
    case 'year':
      return format([y - 1, 1, 1])
  }
}

/** Dzisiejsza data w strefie instalacji. */
export function today(now: Date, timeZone: string): string {
  return localDate(now, timeZone)
}

/** Najdłuższy zakres własny w dniach — jak limit energii i eksportu (D48, D57). */
export const MAX_CUSTOM_DAYS = 400

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isValidDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false
  const [y, m, d] = parse(date)
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
}

/**
 * Zakres własny (D66): dni od `fromDate` do `toDate` włącznie, granice o północy w strefie
 * instalacji. Zwraca komunikat błędu dla niepoprawnych dat, odwróconej kolejności albo zakresu
 * dłuższego niż `MAX_CUSTOM_DAYS`.
 */
export function customRange(
  fromDate: string,
  toDate: string,
  timeZone: string,
): { kind: 'ok'; range: HistoryRange } | { kind: 'invalid'; message: string } {
  if (!isValidDate(fromDate) || !isValidDate(toDate)) {
    return { kind: 'invalid', message: 'Podaj obie daty.' }
  }
  const start = parse(fromDate)
  const last = parse(toDate)
  const days = Math.round((utc(last).getTime() - utc(start).getTime()) / 86_400_000) + 1
  if (days < 1) return { kind: 'invalid', message: 'Data „od” musi być wcześniejsza niż „do” albo taka sama.' }
  if (days > MAX_CUSTOM_DAYS) {
    return { kind: 'invalid', message: `Zakres może mieć najwyżej ${MAX_CUSTOM_DAYS} dni.` }
  }
  return {
    kind: 'ok',
    range: {
      from: localMidnight(start, timeZone),
      to: localMidnight(addDays(last, 1), timeZone),
      label: days === 1 ? DATE.format(utc(start)) : `${SHORT.format(utc(start))} – ${SHORT.format(utc(last))}`,
    },
  }
}
