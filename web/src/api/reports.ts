/**
 * Raport energii instalacji (D74): `GET /api/sites/{id}/reports/energy?year=&month=` — tylko
 * OWNER/ADMIN (serwer zwraca 403 pozostałym). Treść jak energia instalacji (D51) plus okres.
 * CSV pobiera przeglądarka zwykłym linkiem (sesja w ciasteczku).
 */
import { parseSiteEnergy, type SiteEnergy } from './energy'

export type ReportPeriod = 'month' | 'year'

export interface ReportSelection {
  year: number
  /** 1–12; `null` — raport roczny. */
  month: number | null
}

export interface EnergyReport extends SiteEnergy {
  period: ReportPeriod
  year: number
  month: number | null
  start: string
  end: string
}

export type ReportResult =
  | { kind: 'ok'; data: EnergyReport }
  | { kind: 'anonymous' }
  | { kind: 'forbidden' }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string | null }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const isDate = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v))

export function parseReport(v: unknown): EnergyReport | null {
  const energy = parseSiteEnergy(v)
  if (!energy || !isRecord(v)) return null
  const { period, year, month, start, end } = v
  if (
    (period !== 'month' && period !== 'year') ||
    !Number.isInteger(year) ||
    !(month === null || (Number.isInteger(month) && (month as number) >= 1 && (month as number) <= 12)) ||
    (period === 'year') !== (month === null) ||
    !isDate(start) ||
    !isDate(end)
  ) {
    return null
  }
  return { ...energy, period, year: year as number, month: month as number | null, start, end }
}

function params(selection: ReportSelection): URLSearchParams {
  const p = new URLSearchParams({ year: String(selection.year) })
  if (selection.month !== null) p.set('month', String(selection.month))
  return p
}

const base = (siteId: string) => `/api/sites/${encodeURIComponent(siteId)}/reports/energy`

/** Adres pliku CSV raportu (pobranie przez link — audyt po stronie serwera). */
export function reportCsvUrl(siteId: string, selection: ReportSelection): string {
  return `${base(siteId)}.csv?${params(selection)}`
}

export async function getEnergyReport(
  siteId: string,
  selection: ReportSelection,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ReportResult> {
  let response: Response
  try {
    response = await fetchFn(`${base(siteId)}?${params(selection)}`, {
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    })
  } catch {
    return { kind: 'error', message: null }
  }
  if (response.status === 401) return { kind: 'anonymous' }
  if (response.status === 403) return { kind: 'forbidden' }
  if (response.status === 404) return { kind: 'not-found' }
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!response.ok) {
    // 422: komunikat serwera po polsku (np. okres jeszcze się nie zaczął).
    const detail = isRecord(body) && typeof body.detail === 'string' ? body.detail : null
    return { kind: 'error', message: detail }
  }
  const data = parseReport(body)
  return data ? { kind: 'ok', data } : { kind: 'error', message: null }
}
