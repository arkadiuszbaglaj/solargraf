/**
 * Stan serwera (D16, D60): `GET /api/system/health`, tylko rola OWNER (inne role — 403).
 * Wartość `null` metryki to „niedostępne na tym hoście albo brak pomiaru”, nigdy 0.
 */

export type HealthLevel = 'STABLE' | 'WARNING' | 'CRITICAL' | 'UNKNOWN'
export type ReasonSeverity = 'WARNING' | 'CRITICAL'
export type ComponentState = 'UP' | 'DOWN' | 'UNKNOWN'

export interface HealthReason {
  code: string
  severity: ReasonSeverity
  message: string
  since: string | null
}

export interface HealthComponent {
  component: string
  name: string
  state: ComponentState
  checkedAt: string | null
  lastOkAt: string | null
}

/** Metryki hosta w jednostkach kanonicznych (bajty, %, °C, s; flaga 0/1). */
export const METRIC_KEYS = [
  'cpu_percent',
  'cpu_count',
  'load_1m',
  'load_5m',
  'load_15m',
  'mem_used_bytes',
  'mem_total_bytes',
  'swap_used_bytes',
  'swap_total_bytes',
  'disk_used_bytes',
  'disk_total_bytes',
  'db_size_bytes',
  'cpu_temp_c',
  'uptime_s',
  'undervoltage_now',
] as const
export type MetricKey = (typeof METRIC_KEYS)[number]

export interface SystemHealth {
  level: HealthLevel
  reasons: HealthReason[]
  evaluatedAt: string | null
  stale: boolean
  sampledAt: string | null
  metrics: Record<MetricKey, number | null>
  percent: { memory: number | null; swap: number | null; disk: number | null }
  components: HealthComponent[]
  appVersion: string
  serverTime: string
}

export type HealthResult =
  | { kind: 'ok'; data: SystemHealth }
  | { kind: 'anonymous' }
  | { kind: 'forbidden' }
  | { kind: 'error' }

const LEVELS: ReadonlySet<string> = new Set(['STABLE', 'WARNING', 'CRITICAL', 'UNKNOWN'])
const SEVERITIES: ReadonlySet<string> = new Set(['WARNING', 'CRITICAL'])
const STATES: ReadonlySet<string> = new Set(['UP', 'DOWN', 'UNKNOWN'])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v))
const timeOrNull = (v: unknown): string | null | undefined => (v === null ? null : isTime(v) ? v : undefined)
const numberOrNull = (v: unknown): number | null | undefined =>
  v === null ? null : typeof v === 'number' && Number.isFinite(v) ? v : undefined

function parseReason(v: unknown): HealthReason | null {
  if (!isRecord(v)) return null
  const since = timeOrNull(v.since)
  if (
    typeof v.code !== 'string' ||
    typeof v.severity !== 'string' ||
    !SEVERITIES.has(v.severity) ||
    typeof v.message !== 'string' ||
    since === undefined
  ) {
    return null
  }
  return { code: v.code, severity: v.severity as ReasonSeverity, message: v.message, since }
}

function parseComponent(v: unknown): HealthComponent | null {
  if (!isRecord(v)) return null
  const checkedAt = timeOrNull(v.checked_at)
  const lastOkAt = timeOrNull(v.last_ok_at)
  if (
    typeof v.component !== 'string' ||
    typeof v.name !== 'string' ||
    typeof v.state !== 'string' ||
    !STATES.has(v.state) ||
    checkedAt === undefined ||
    lastOkAt === undefined
  ) {
    return null
  }
  return { component: v.component, name: v.name, state: v.state as ComponentState, checkedAt, lastOkAt }
}

function parseList<T>(v: unknown, parse: (x: unknown) => T | null): T[] | null {
  if (!Array.isArray(v)) return null
  const out: T[] = []
  for (const item of v) {
    const parsed = parse(item)
    if (parsed === null) return null
    out.push(parsed)
  }
  return out
}

/** Walidacja odpowiedzi na granicy — nieznany kształt to błąd, nie zgadywanie. */
export function parseSystemHealth(v: unknown): SystemHealth | null {
  if (!isRecord(v) || !isRecord(v.metrics) || !isRecord(v.percent)) return null
  const reasons = parseList(v.reasons, parseReason)
  const components = parseList(v.components, parseComponent)
  const evaluatedAt = timeOrNull(v.evaluated_at)
  const sampledAt = timeOrNull(v.sampled_at)
  const memory = numberOrNull(v.percent.memory)
  const swap = numberOrNull(v.percent.swap)
  const disk = numberOrNull(v.percent.disk)
  if (
    typeof v.level !== 'string' ||
    !LEVELS.has(v.level) ||
    reasons === null ||
    components === null ||
    evaluatedAt === undefined ||
    sampledAt === undefined ||
    typeof v.stale !== 'boolean' ||
    memory === undefined ||
    swap === undefined ||
    disk === undefined ||
    typeof v.app_version !== 'string' ||
    !isTime(v.server_time)
  ) {
    return null
  }
  const metrics = {} as Record<MetricKey, number | null>
  for (const key of METRIC_KEYS) {
    const value = numberOrNull(v.metrics[key])
    // Brak klucza traktujemy jak brak pomiaru; zły typ — jak błąd odpowiedzi.
    if (value === undefined && key in v.metrics) return null
    metrics[key] = value ?? null
  }
  return {
    level: v.level as HealthLevel,
    reasons,
    evaluatedAt,
    stale: v.stale,
    sampledAt,
    metrics,
    percent: { memory, swap, disk },
    components,
    appVersion: v.app_version,
    serverTime: v.server_time,
  }
}

export async function getSystemHealth(fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<HealthResult> {
  let response: Response
  try {
    response = await fetchFn('/api/system/health', { credentials: 'same-origin', ...(signal ? { signal } : {}) })
  } catch {
    return { kind: 'error' }
  }
  if (response.status === 401) return { kind: 'anonymous' }
  if (response.status === 403) return { kind: 'forbidden' }
  if (!response.ok) return { kind: 'error' }
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    return { kind: 'error' }
  }
  const data = parseSystemHealth(body)
  return data === null ? { kind: 'error' } : { kind: 'ok', data }
}

// --- historia (D61): `GET /api/system/metrics?range=24h|7d|30d` ---------------------------

export const HISTORY_RANGES = ['24h', '7d', '30d'] as const
export type HistoryRange = (typeof HISTORY_RANGES)[number]
export const SERIES_KEYS = ['cpu_percent', 'memory_percent', 'disk_percent', 'cpu_temp_c'] as const
export type SeriesKey = (typeof SERIES_KEYS)[number]
export type ForecastStatus = 'OK' | 'OVER_YEAR' | 'NOT_GROWING' | 'INSUFFICIENT_DATA'

export interface MetricPoint {
  t: string
  /** `null` — brak próbek w przedziale (luka), nie 0. */
  avg: number | null
  max: number | null
}

export interface SystemMetrics {
  range: HistoryRange
  stepSeconds: number
  start: string
  end: string
  series: Record<SeriesKey, { unit: string; points: MetricPoint[] }>
  diskForecast: { status: ForecastStatus; fullAt: string | null; growthBytesPerDay: number | null }
}

export type MetricsResult =
  | { kind: 'ok'; data: SystemMetrics }
  | { kind: 'anonymous' }
  | { kind: 'forbidden' }
  | { kind: 'error' }

const RANGES: ReadonlySet<string> = new Set(HISTORY_RANGES)
const FORECASTS: ReadonlySet<string> = new Set(['OK', 'OVER_YEAR', 'NOT_GROWING', 'INSUFFICIENT_DATA'])

function parsePoint(v: unknown): MetricPoint | null {
  if (!isRecord(v) || !isTime(v.t)) return null
  const avg = numberOrNull(v.avg)
  const max = numberOrNull(v.max)
  return avg === undefined || max === undefined ? null : { t: v.t, avg, max }
}

export function parseSystemMetrics(v: unknown): SystemMetrics | null {
  if (!isRecord(v) || !isRecord(v.series) || !isRecord(v.disk_forecast)) return null
  const f = v.disk_forecast
  const fullAt = timeOrNull(f.full_at)
  const growth = numberOrNull(f.growth_bytes_per_day)
  if (
    typeof v.range !== 'string' ||
    !RANGES.has(v.range) ||
    typeof v.step_s !== 'number' ||
    !isTime(v.start) ||
    !isTime(v.end) ||
    typeof f.status !== 'string' ||
    !FORECASTS.has(f.status) ||
    fullAt === undefined ||
    growth === undefined
  ) {
    return null
  }
  const series = {} as SystemMetrics['series']
  for (const key of SERIES_KEYS) {
    const s = v.series[key]
    if (!isRecord(s) || typeof s.unit !== 'string') return null
    const points = parseList(s.points, parsePoint)
    if (points === null) return null
    series[key] = { unit: s.unit, points }
  }
  return {
    range: v.range as HistoryRange,
    stepSeconds: v.step_s,
    start: v.start,
    end: v.end,
    series,
    diskForecast: { status: f.status as ForecastStatus, fullAt, growthBytesPerDay: growth },
  }
}

export async function getSystemMetrics(
  range: HistoryRange,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<MetricsResult> {
  let response: Response
  try {
    response = await fetchFn(`/api/system/metrics?range=${range}`, {
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    })
  } catch {
    return { kind: 'error' }
  }
  if (response.status === 401) return { kind: 'anonymous' }
  if (response.status === 403) return { kind: 'forbidden' }
  if (!response.ok) return { kind: 'error' }
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    return { kind: 'error' }
  }
  const data = parseSystemMetrics(body)
  return data === null ? { kind: 'error' } : { kind: 'ok', data }
}
