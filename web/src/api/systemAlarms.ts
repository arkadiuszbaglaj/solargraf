/**
 * Alarmy systemowe (P7.1d, D68): `GET /api/system/alarms` i potwierdzenie — tylko rola OWNER.
 * Odpowiedzi walidowane; szczegóły błędów serwera nie trafiają do UI.
 */

export type SystemAlarmSeverity = 'WARNING' | 'CRITICAL'

export interface SystemAlarm {
  id: string
  code: string
  severity: SystemAlarmSeverity
  message: string
  openedAt: string
  lastSeenAt: string
  closedAt: string | null
  acknowledgedAt: string | null
  acknowledgedBy: string | null
}

export interface SystemAlarms {
  alarms: SystemAlarm[]
  /** Worker nie mierzy — lista może być nieaktualna. */
  workerStale: boolean
  workerStaleSince: string | null
}

export type SystemAlarmsResult =
  | { kind: 'ok'; data: SystemAlarms }
  | { kind: 'anonymous' }
  | { kind: 'forbidden' }
  | { kind: 'error' }

export type SystemAckResult = { ok: true; alarm: SystemAlarm } | { ok: false; message: string }

const BASE = '/api/system/alarms'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v))
const timeOrNull = (v: unknown): string | null | undefined => (v === null ? null : isTime(v) ? v : undefined)

export function parseSystemAlarm(v: unknown): SystemAlarm | null {
  if (!isRecord(v)) return null
  const closedAt = timeOrNull(v.closed_at)
  const acknowledgedAt = timeOrNull(v.acknowledged_at)
  if (
    typeof v.id !== 'string' ||
    typeof v.code !== 'string' ||
    (v.severity !== 'WARNING' && v.severity !== 'CRITICAL') ||
    typeof v.message !== 'string' ||
    !isTime(v.opened_at) ||
    !isTime(v.last_seen_at) ||
    closedAt === undefined ||
    acknowledgedAt === undefined ||
    !(v.acknowledged_by === null || typeof v.acknowledged_by === 'string')
  ) {
    return null
  }
  return {
    id: v.id,
    code: v.code,
    severity: v.severity,
    message: v.message,
    openedAt: v.opened_at,
    lastSeenAt: v.last_seen_at,
    closedAt,
    acknowledgedAt,
    acknowledgedBy: v.acknowledged_by,
  }
}

export function parseSystemAlarms(v: unknown): SystemAlarms | null {
  if (!isRecord(v) || !Array.isArray(v.alarms) || typeof v.worker_stale !== 'boolean') return null
  const since = timeOrNull(v.worker_stale_since)
  if (since === undefined) return null
  const alarms: SystemAlarm[] = []
  for (const item of v.alarms) {
    const alarm = parseSystemAlarm(item)
    if (!alarm) return null
    alarms.push(alarm)
  }
  return { alarms, workerStale: v.worker_stale, workerStaleSince: since }
}

export async function getSystemAlarms(fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<SystemAlarmsResult> {
  let response: Response
  try {
    response = await fetchFn(BASE, { credentials: 'same-origin', ...(signal ? { signal } : {}) })
  } catch {
    return { kind: 'error' }
  }
  if (response.status === 401) return { kind: 'anonymous' }
  if (response.status === 403) return { kind: 'forbidden' }
  if (!response.ok) return { kind: 'error' }
  try {
    const data = parseSystemAlarms(await response.json())
    return data ? { kind: 'ok', data } : { kind: 'error' }
  } catch {
    return { kind: 'error' }
  }
}

export async function acknowledgeSystemAlarm(
  alarmId: string,
  csrfToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<SystemAckResult> {
  let response: Response
  try {
    response = await fetchFn(`${BASE}/${encodeURIComponent(alarmId)}/acknowledge`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfToken },
      credentials: 'same-origin',
    })
  } catch {
    return { ok: false, message: 'Brak połączenia z serwerem.' }
  }
  if (response.status === 401) return { ok: false, message: 'Sesja wygasła.' }
  if (response.status === 403) return { ok: false, message: 'Tylko właściciel organizacji może potwierdzać alarmy serwera.' }
  if (response.status === 404) return { ok: false, message: 'Nie znaleziono alarmu.' }
  if (!response.ok) return { ok: false, message: 'Nie udało się potwierdzić alarmu.' }
  try {
    const alarm = parseSystemAlarm(await response.json())
    return alarm ? { ok: true, alarm } : { ok: false, message: 'Nieoczekiwana odpowiedź serwera.' }
  } catch {
    return { ok: false, message: 'Nieoczekiwana odpowiedź serwera.' }
  }
}

/** Co pokazuje baner (D68): niepotwierdzone otwarte, krytyczne otwarte także po potwierdzeniu. */
export function bannerAlarms(alarms: readonly SystemAlarm[]): SystemAlarm[] {
  return alarms.filter((a) => a.closedAt === null && (a.acknowledgedAt === null || a.severity === 'CRITICAL'))
}
