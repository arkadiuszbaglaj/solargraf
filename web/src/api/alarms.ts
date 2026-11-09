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

const base = (siteId: string) => `/api/sites/${encodeURIComponent(siteId)}/alarms`

/** Najwięcej alarmów w jednej odpowiedzi (limit API, D55). */
export const ALARMS_MAX_LIMIT = 200

export const listAlarms = (
  siteId: string,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
  limit?: number,
): Promise<Loaded<AlarmList>> =>
  load(limit === undefined ? base(siteId) : `${base(siteId)}?limit=${limit}`, parseAlarmList, fetchFn, signal)

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
