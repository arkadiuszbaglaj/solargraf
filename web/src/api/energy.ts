/**
 * Energia za okres i wskaźniki D27 (D48). Odpowiedź walidowana; brak wartości to `null`, nigdy 0.
 */

export type EnergyBucketSize = '1h' | '1d' | '1mo'
export type KpiStatus = 'OK' | 'INCOMPLETE' | 'UNAVAILABLE' | 'INCONSISTENT'
export type EnergyKey = 'pv' | 'grid_import' | 'grid_export' | 'battery_charge' | 'battery_discharge' | 'load'

export interface EnergyBucket {
  t: string
  wh: number | null
  coverage: number
}

export interface EnergySeries {
  key: EnergyKey
  metric: string
  /** COUNTER — przyrost licznika; POWER — moc zintegrowana w czasie (wartość pochodna). */
  source: 'COUNTER' | 'POWER'
  totalWh: number | null
  coverage: number
  resetDetected: boolean
  buckets: EnergyBucket[]
}

export interface Kpi {
  value: number | null
  status: KpiStatus
  reason: string | null
  coverage: number
  definition: string
}

export interface Energy {
  timezone: string
  bucket: EnergyBucketSize
  origins: string[]
  series: EnergySeries[]
  kpis: { selfConsumption: Kpi; selfSufficiency: Kpi }
}

export type EnergyResult = { kind: 'ok'; data: Energy } | { kind: 'anonymous' } | { kind: 'not-found' } | { kind: 'error' }

const KEYS: ReadonlySet<string> = new Set(['pv', 'grid_import', 'grid_export', 'battery_charge', 'battery_discharge', 'load'])
const STATUSES: ReadonlySet<string> = new Set(['OK', 'INCOMPLETE', 'UNAVAILABLE', 'INCONSISTENT'])
const BUCKETS: ReadonlySet<string> = new Set(['1h', '1d', '1mo'])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const finiteOrNull = (v: unknown): number | null | undefined => (v === null ? null : finite(v) ? v : undefined)

function parseBucket(v: unknown): EnergyBucket | null {
  if (!isRecord(v) || typeof v.t !== 'string' || Number.isNaN(Date.parse(v.t)) || !finite(v.coverage)) return null
  const wh = finiteOrNull(v.wh)
  return wh === undefined ? null : { t: v.t, wh, coverage: v.coverage }
}

function parseSeries(v: unknown): EnergySeries | null {
  if (!isRecord(v)) return null
  const { key, metric, source, coverage, reset_detected: reset, buckets } = v
  const total = finiteOrNull(v.total_wh)
  if (
    typeof key !== 'string' ||
    !KEYS.has(key) ||
    typeof metric !== 'string' ||
    (source !== 'COUNTER' && source !== 'POWER') ||
    total === undefined ||
    !finite(coverage) ||
    typeof reset !== 'boolean' ||
    !Array.isArray(buckets)
  ) {
    return null
  }
  const parsed: EnergyBucket[] = []
  for (const b of buckets) {
    const bucket = parseBucket(b)
    if (!bucket) return null
    parsed.push(bucket)
  }
  return { key: key as EnergyKey, metric, source, totalWh: total, coverage, resetDetected: reset, buckets: parsed }
}

function parseKpi(v: unknown): Kpi | null {
  if (!isRecord(v)) return null
  const value = finiteOrNull(v.value)
  const { status, reason, coverage, definition } = v
  if (
    value === undefined ||
    typeof status !== 'string' ||
    !STATUSES.has(status) ||
    !(reason === null || typeof reason === 'string') ||
    !finite(coverage) ||
    typeof definition !== 'string'
  ) {
    return null
  }
  return { value, status: status as KpiStatus, reason, coverage, definition }
}

export function parseEnergy(v: unknown): Energy | null {
  if (!isRecord(v) || !isRecord(v.kpis)) return null
  const { timezone, bucket, origins, series } = v
  if (
    typeof timezone !== 'string' ||
    typeof bucket !== 'string' ||
    !BUCKETS.has(bucket) ||
    !Array.isArray(origins) ||
    !origins.every((o) => typeof o === 'string') ||
    !Array.isArray(series)
  ) {
    return null
  }
  const parsed: EnergySeries[] = []
  for (const s of series) {
    const one = parseSeries(s)
    if (!one) return null
    parsed.push(one)
  }
  const selfConsumption = parseKpi(v.kpis.self_consumption)
  const selfSufficiency = parseKpi(v.kpis.self_sufficiency)
  if (!selfConsumption || !selfSufficiency) return null
  return {
    timezone,
    bucket: bucket as EnergyBucketSize,
    origins: origins as string[],
    series: parsed,
    kpis: { selfConsumption, selfSufficiency },
  }
}

export async function getEnergy(
  siteId: string,
  deviceId: string,
  range: { from: Date; to: Date },
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<EnergyResult> {
  const params = new URLSearchParams({ from: range.from.toISOString(), to: range.to.toISOString() })
  const url = `/api/sites/${encodeURIComponent(siteId)}/devices/${encodeURIComponent(deviceId)}/energy?${params}`
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
  const data = parseEnergy(body)
  return data ? { kind: 'ok', data } : { kind: 'error' }
}
