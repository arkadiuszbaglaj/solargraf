/**
 * Historia metryki urządzenia (D46, D47). Odpowiedź walidowana; brak wartości to `null`, nigdy 0.
 */

export type HistoryResolution = 'raw' | '5m' | '1h' | '1d'

export interface HistoryPoint {
  /** Początek przedziału (albo czas odczytu dla `raw`), UTC ISO 8601. */
  t: string
  value: number | null
  min: number | null
  max: number | null
  /** Pokrycie przedziału próbkami GOOD (0–1); `null` dla surowych odczytów. */
  coverage: number | null
}

export interface History {
  metric: string
  channel: number | null
  unit: string
  cumulative: boolean
  resolution: HistoryResolution
  timezone: string
  /** Pochodzenie surowych pomiarów w zakresie, np. SIMULATED — UI musi je oznaczyć. */
  origins: string[]
  points: HistoryPoint[]
}

export type HistoryResult = { kind: 'ok'; data: History } | { kind: 'anonymous' } | { kind: 'not-found' } | { kind: 'error' }

const RESOLUTIONS: ReadonlySet<string> = new Set(['raw', '5m', '1h', '1d'])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const numOrNull = (v: unknown): number | null | undefined =>
  v === null || v === undefined ? null : typeof v === 'number' && Number.isFinite(v) ? v : undefined

function parsePoint(v: unknown): HistoryPoint | null {
  if (!isRecord(v) || typeof v.t !== 'string' || Number.isNaN(Date.parse(v.t))) return null
  const value = numOrNull(v.value)
  const min = numOrNull(v.min)
  const max = numOrNull(v.max)
  const coverage = numOrNull(v.coverage)
  if (value === undefined || min === undefined || max === undefined || coverage === undefined) return null
  return { t: v.t, value, min, max, coverage }
}

export function parseHistory(v: unknown): History | null {
  if (!isRecord(v)) return null
  const { metric, channel, unit, cumulative, resolution, timezone, origins, points } = v
  if (
    typeof metric !== 'string' ||
    !(channel === null || Number.isInteger(channel)) ||
    typeof unit !== 'string' ||
    typeof cumulative !== 'boolean' ||
    typeof resolution !== 'string' ||
    !RESOLUTIONS.has(resolution) ||
    typeof timezone !== 'string' ||
    !Array.isArray(origins) ||
    !origins.every((o) => typeof o === 'string') ||
    !Array.isArray(points)
  ) {
    return null
  }
  const parsed: HistoryPoint[] = []
  for (const p of points) {
    const point = parsePoint(p)
    if (!point) return null
    parsed.push(point)
  }
  return {
    metric,
    channel: channel as number | null,
    unit,
    cumulative,
    resolution: resolution as HistoryResolution,
    timezone,
    origins: origins as string[],
    points: parsed,
  }
}

export interface HistoryQuery {
  metric: string
  channel: number | null
  from: Date
  to: Date
  /** Domyślnie `auto`; wykres „dziś” wymusza `5m`, żeby luki były punktami `null`. */
  resolution?: HistoryResolution | 'auto'
}

export async function getHistory(
  siteId: string,
  deviceId: string,
  query: HistoryQuery,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<HistoryResult> {
  const params = new URLSearchParams({
    metric: query.metric,
    from: query.from.toISOString(),
    to: query.to.toISOString(),
    resolution: query.resolution ?? 'auto',
  })
  if (query.channel !== null) params.set('channel', String(query.channel))
  const url = `/api/sites/${encodeURIComponent(siteId)}/devices/${encodeURIComponent(deviceId)}/history?${params}`
  let response: Response
  try {
    response = await fetchFn(url, { credentials: 'same-origin', ...(signal ? { signal } : {}) })
  } catch {
    return { kind: 'error' }
  }
  if (response.status === 401) return { kind: 'anonymous' }
  if (response.status === 404) return { kind: 'not-found' }
  if (!response.ok) return { kind: 'error' }
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    return { kind: 'error' }
  }
  const data = parseHistory(body)
  return data ? { kind: 'ok', data } : { kind: 'error' }
}
