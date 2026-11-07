/**
 * Strumień na żywo instalacji (D50): `GET /api/sites/{id}/live` — Server-Sent Events.
 * Zdarzenie `snapshot` (urządzenia z metrykami i ostatnie odczyty), potem `readings`.
 * Dane z sieci są walidowane; niepoprawne zdarzenie jest pomijane, nigdy zgadywane.
 */
import { parseMetric, type ApiDeviceMetric } from './devices'

export type LiveQuality = 'GOOD' | 'INVALID' | 'MISSING'
export type LiveOrigin = 'DEVICE' | 'SIMULATED'

export interface LiveReading {
  deviceId: string
  metric: string
  channel: number | null
  /** Wartość w jednostce kanonicznej; null = brak odczytu (nigdy zastępcze 0). */
  value: number | null
  quality: LiveQuality
  origin: LiveOrigin
  /** Czas przyjęcia odczytu przez agenta, UTC ISO 8601. */
  receivedAt: string
}

export interface LiveDevice {
  id: string
  name: string
  kind: string
  enabled: boolean
  freshnessThresholdSeconds: number
  metrics: ApiDeviceMetric[]
}

export interface LiveSnapshot {
  timezone: string
  devices: LiveDevice[]
  readings: LiveReading[]
}

const QUALITIES: ReadonlySet<string> = new Set(['GOOD', 'INVALID', 'MISSING'])
const ORIGINS: ReadonlySet<string> = new Set(['DEVICE', 'SIMULATED'])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function list<T>(v: unknown, parse: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(v)) return null
  const out: T[] = []
  for (const item of v) {
    const parsed = parse(item)
    if (parsed === null) return null
    out.push(parsed)
  }
  return out
}

export function parseReading(v: unknown): LiveReading | null {
  if (!isRecord(v)) return null
  const { device_id: deviceId, metric, channel, value, quality, origin, received_at: receivedAt } = v
  if (
    typeof deviceId !== 'string' ||
    typeof metric !== 'string' ||
    !(channel === null || Number.isInteger(channel)) ||
    !(value === null || (typeof value === 'number' && Number.isFinite(value))) ||
    typeof quality !== 'string' ||
    !QUALITIES.has(quality) ||
    typeof origin !== 'string' ||
    !ORIGINS.has(origin) ||
    typeof receivedAt !== 'string' ||
    Number.isNaN(Date.parse(receivedAt))
  ) {
    return null
  }
  return {
    deviceId,
    metric,
    channel: channel as number | null,
    value: value as number | null,
    quality: quality as LiveQuality,
    origin: origin as LiveOrigin,
    receivedAt,
  }
}

function parseDevice(v: unknown): LiveDevice | null {
  if (!isRecord(v)) return null
  const { id, name, kind, enabled, freshness_threshold_seconds: threshold } = v
  const metrics = list(v.metrics, parseMetric)
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof kind !== 'string' ||
    typeof enabled !== 'boolean' ||
    !Number.isInteger(threshold) ||
    (threshold as number) <= 0 ||
    metrics === null
  ) {
    return null
  }
  return { id, name, kind, enabled, freshnessThresholdSeconds: threshold as number, metrics }
}

function json(data: string): unknown {
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}

export function parseSnapshot(data: string): LiveSnapshot | null {
  const v = json(data)
  if (!isRecord(v) || typeof v.timezone !== 'string') return null
  const devices = list(v.devices, parseDevice)
  const readings = list(v.readings, parseReading)
  return devices && readings ? { timezone: v.timezone, devices, readings } : null
}

export function parseReadings(data: string): LiveReading[] | null {
  const v = json(data)
  return isRecord(v) ? list(v.readings, parseReading) : null
}

/** Minimalny interfejs EventSource — w testach podmieniany atrapą. */
export interface LiveEventSource {
  readonly readyState: number
  /** `snapshot`/`readings` dostają `MessageEvent`; `error` — zwykłe zdarzenie bez danych. */
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void
  close(): void
}

export type LiveSourceFactory = (url: string) => LiveEventSource

export const CLOSED = 2

export const liveUrl = (siteId: string): string => `/api/sites/${encodeURIComponent(siteId)}/live`

export const browserLiveSource: LiveSourceFactory = (url) => new EventSource(url)
