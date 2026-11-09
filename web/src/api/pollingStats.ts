/**
 * Jakość odczytów urządzenia z ostatnich 24 h (D76): przebiegi OK / częściowe / nieudane,
 * udział poprawnych parametrów i ostatnie błędy. Brak przebiegów to `null`, nie 0 %.
 */

export interface PollingError {
  startedAt: string
  result: 'PARTIAL' | 'FAILED'
  errorCode: string | null
  /** Stały opis agenta bez adresu urządzenia. */
  errorDetail: string | null
  failedPoints: number
}

export interface PollingStats {
  windowStart: string
  windowEnd: string
  runsOk: number
  runsPartial: number
  runsFailed: number
  okPoints: number
  failedPoints: number
  /** Punkty poprawne / wszystkie (0–1); `null`, gdy w oknie nie było odczytów. */
  pointsOkRatio: number | null
  lastRunAt: string | null
  recentErrors: PollingError[]
}

export type PollingStatsResult = { kind: 'ok'; data: PollingStats } | { kind: 'anonymous' } | { kind: 'error' }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v))
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string'

function parseError(v: unknown): PollingError | null {
  if (
    !isRecord(v) ||
    !isTime(v.started_at) ||
    (v.result !== 'PARTIAL' && v.result !== 'FAILED') ||
    !strOrNull(v.error_code) ||
    !strOrNull(v.error_detail) ||
    !isCount(v.failed_points)
  ) {
    return null
  }
  return {
    startedAt: v.started_at,
    result: v.result,
    errorCode: v.error_code,
    errorDetail: v.error_detail,
    failedPoints: v.failed_points,
  }
}

export function parsePollingStats(v: unknown): PollingStats | null {
  if (!isRecord(v)) return null
  const ratio = v.points_ok_ratio
  if (
    !isTime(v.window_start) ||
    !isTime(v.window_end) ||
    !isCount(v.runs_ok) ||
    !isCount(v.runs_partial) ||
    !isCount(v.runs_failed) ||
    !isCount(v.ok_points) ||
    !isCount(v.failed_points) ||
    !(ratio === null || (typeof ratio === 'number' && ratio >= 0 && ratio <= 1)) ||
    !(v.last_run_at === null || isTime(v.last_run_at)) ||
    !Array.isArray(v.recent_errors)
  ) {
    return null
  }
  const errors: PollingError[] = []
  for (const e of v.recent_errors) {
    const parsed = parseError(e)
    if (!parsed) return null
    errors.push(parsed)
  }
  return {
    windowStart: v.window_start,
    windowEnd: v.window_end,
    runsOk: v.runs_ok,
    runsPartial: v.runs_partial,
    runsFailed: v.runs_failed,
    okPoints: v.ok_points,
    failedPoints: v.failed_points,
    pointsOkRatio: ratio,
    lastRunAt: v.last_run_at,
    recentErrors: errors,
  }
}

export async function getPollingStats(
  siteId: string,
  deviceId: string,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<PollingStatsResult> {
  const url = `/api/sites/${encodeURIComponent(siteId)}/devices/${encodeURIComponent(deviceId)}/polling-stats`
  let response: Response
  try {
    response = await fetchFn(url, { credentials: 'same-origin', ...(signal ? { signal } : {}) })
  } catch {
    return { kind: 'error' }
  }
  if (response.status === 401) return { kind: 'anonymous' }
  if (!response.ok) return { kind: 'error' }
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    return { kind: 'error' }
  }
  const data = parsePollingStats(body)
  return data ? { kind: 'ok', data } : { kind: 'error' }
}
