/**
 * Alarmy instalacji (D55): `GET /api/sites/{id}/alarms` i potwierdzanie
 * `POST …/alarms/{alarmId}/acknowledge` (OWNER/ADMIN, z CSRF). Uprawnienia sprawdza serwer;
 * `canAcknowledge` mówi tylko, czy pokazać przycisk.
 */
import { load, type Loaded } from './devices'

export type AlarmSeverity = 'CRITICAL' | 'WARNING' | 'INFO'

export interface ApiAlarm {
  id: string
  code: string
  severity: AlarmSeverity
  title: string
  details: string | null
  deviceId: string | null
  /** Ostatni udany odczyt albo heartbeat agenta (UTC); null = nigdy. */
  lastOkAt: string | null
  openedAt: string
  lastSeenAt: string
  closedAt: string | null
  acknowledgedAt: string | null
  acknowledgedBy: string | null
}

export interface AlarmList {
  alarms: ApiAlarm[]
  canAcknowledge: boolean
}

const SEVERITIES: ReadonlySet<string> = new Set(['CRITICAL', 'WARNING', 'INFO'])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v))
const optional = <T>(v: unknown, ok: (x: unknown) => x is T): T | null | undefined =>
  v === null ? null : ok(v) ? v : undefined
const isString = (v: unknown): v is string => typeof v === 'string'

export function parseAlarm(v: unknown): ApiAlarm | null {
  if (!isRecord(v)) return null
  const { id, code, severity, title, opened_at: openedAt, last_seen_at: lastSeenAt } = v
  const details = optional(v.details, isString)
  const deviceId = optional(v.device_id, isString)
  const closedAt = optional(v.closed_at, isTime)
  const lastOkAt = optional(v.last_ok_at, isTime)
  const acknowledgedAt = optional(v.acknowledged_at, isTime)
  const acknowledgedBy = optional(v.acknowledged_by, isString)
  if (
    typeof id !== 'string' ||
    typeof code !== 'string' ||
    typeof severity !== 'string' ||
    !SEVERITIES.has(severity) ||
    typeof title !== 'string' ||
    !isTime(openedAt) ||
    !isTime(lastSeenAt) ||
    details === undefined ||
    deviceId === undefined ||
    closedAt === undefined ||
    lastOkAt === undefined ||
    acknowledgedAt === undefined ||
    acknowledgedBy === undefined
  ) {
    return null
  }
  return {
    id,
    code,
    severity: severity as AlarmSeverity,
    title,
    details,
    deviceId,
    lastOkAt,
    openedAt,
    lastSeenAt,
    closedAt,
    acknowledgedAt,
    acknowledgedBy,
  }
}

export function parseAlarmList(v: unknown): AlarmList | null {
  if (!isRecord(v) || !Array.isArray(v.alarms) || typeof v.can_acknowledge !== 'boolean') return null
  const alarms: ApiAlarm[] = []
  for (const item of v.alarms) {
    const alarm = parseAlarm(item)
    if (!alarm) return null
    alarms.push(alarm)
  }
  return { alarms, canAcknowledge: v.can_acknowledge }
}

/** Okresy historii (D76): 1 = 24 h dla każdego członka, dłuższe tylko OWNER/ADMIN. */
export const ALARM_HISTORY_DAYS = [1, 7, 30, 90, 365] as const
export type AlarmHistoryDays = (typeof ALARM_HISTORY_DAYS)[number]
export type AlarmStateFilter = 'all' | 'active' | 'unacknowledged' | 'closed'

export interface AlarmSummary {
  criticalActive: number
  warningActive: number
  unacknowledged: number
  closed: number
}

/** Strona listy alarmów z historią: `total` pasujących, `summary` całego okresu bez filtrów. */
export interface AlarmPage extends AlarmList {
  days: AlarmHistoryDays
  total: number
  hasMore: boolean
  canViewHistory: boolean
  summary: AlarmSummary
}

export interface AlarmQuery {
  days: AlarmHistoryDays
  state: AlarmStateFilter
  severity: AlarmSeverity | 'all'
  offset: number
  limit: number
}

const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0
const isDays = (v: unknown): v is AlarmHistoryDays => ALARM_HISTORY_DAYS.some((d) => d === v)

export function parseAlarmPage(v: unknown): AlarmPage | null {
  const list = parseAlarmList(v)
  if (!list || !isRecord(v)) return null
  const { days, total, has_more: hasMore, can_view_history: canViewHistory, summary: s } = v
  if (
    !isDays(days) ||
    !isCount(total) ||
    typeof hasMore !== 'boolean' ||
    typeof canViewHistory !== 'boolean' ||
    !isRecord(s) ||
    !isCount(s.critical_active) ||
    !isCount(s.warning_active) ||
    !isCount(s.unacknowledged) ||
    !isCount(s.closed)
  ) {
    return null
  }
  return {
    ...list,
    days,
    total,
    hasMore,
    canViewHistory,
    summary: {
      criticalActive: s.critical_active,
      warningActive: s.warning_active,
      unacknowledged: s.unacknowledged,
      closed: s.closed,
    },
  }
}

export function alarmPageUrl(siteId: string, query: AlarmQuery): string {
  const params = new URLSearchParams({ days: String(query.days), limit: String(query.limit) })
  if (query.offset > 0) params.set('offset', String(query.offset))
  if (query.state !== 'all') params.set('state', query.state)
  if (query.severity !== 'all') params.set('severity', query.severity)
  return `${base(siteId)}?${params}`
}

export const listAlarmPage = (
  siteId: string,
  query: AlarmQuery,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Loaded<AlarmPage>> => load(alarmPageUrl(siteId, query), parseAlarmPage, fetchFn, signal)

const base = (siteId: string) => `/api/sites/${encodeURIComponent(siteId)}/alarms`

/** Alarmy dashboardu: domyślny okres 24 h i domyślny limit API. */
export const listAlarms = (
  siteId: string,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Loaded<AlarmList>> => load(base(siteId), parseAlarmList, fetchFn, signal)

export type AckResult = { ok: true; alarm: ApiAlarm } | { ok: false; message: string }

export async function acknowledgeAlarm(
  siteId: string,
  alarmId: string,
  csrfToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<AckResult> {
  let response: Response
  try {
    response = await fetchFn(`${base(siteId)}/${encodeURIComponent(alarmId)}/acknowledge`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfToken },
      credentials: 'same-origin',
    })
  } catch {
    return { ok: false, message: 'Brak połączenia z serwerem.' }
  }
  if (response.status === 401) return { ok: false, message: 'Sesja wygasła.' }
  if (response.status === 403) return { ok: false, message: 'Nie masz uprawnień do potwierdzania alarmów.' }
  if (response.status === 404) return { ok: false, message: 'Nie znaleziono alarmu.' }
  if (!response.ok) return { ok: false, message: 'Nie udało się potwierdzić alarmu.' }
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  const alarm = parseAlarm(body)
  return alarm ? { ok: true, alarm } : { ok: false, message: 'Nieoczekiwana odpowiedź serwera.' }
}
