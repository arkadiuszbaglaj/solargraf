/**
 * Wartości instalacji z odczytów urządzeń na żywo (D50). Czyste funkcje — bez UI i zegara.
 *
 * - Metrykę instalacji podaje dokładnie jedno włączone urządzenie, którego profil ją udostępnia.
 *   Kilka źródeł → wartość niedostępna (bez sumowania: licznik i falownik mogą mierzyć to samo).
 * - Brak odczytu, `MISSING` albo `INVALID` → brak danych, nigdy 0.
 * - Wartość jest nieaktualna, gdy jej wiek (od `receivedAt`) przekracza próg świeżości urządzenia.
 */
import type { LiveDevice, LiveOrigin, LiveReading } from '../api/live'

export type ReadingMap = ReadonlyMap<string, LiveReading>

export const readingKey = (deviceId: string, metric: string, channel: number | null): string =>
  `${deviceId}|${metric}|${channel ?? 0}`

/** Dokłada odczyty, zostawiając dla każdego klucza najnowszy (po `receivedAt`). */
export function mergeReadings(current: ReadingMap, readings: readonly LiveReading[]): Map<string, LiveReading> {
  const next = new Map(current)
  for (const r of readings) {
    const key = readingKey(r.deviceId, r.metric, r.channel)
    const known = next.get(key)
    if (!known || Date.parse(r.receivedAt) >= Date.parse(known.receivedAt)) {
      next.set(key, r)
    }
  }
  return next
}

/** Urządzenie z metrykami z profilu — wspólny kształt dla strumienia i listy urządzeń. */
export interface MetricSourceDevice {
  id: string
  enabled: boolean
  metrics: ReadonlyArray<{ key: string; channel: number | null }>
}

export type Source<T> = { kind: 'one'; device: T } | { kind: 'none' } | { kind: 'many'; count: number }

/** Jedno włączone urządzenie podające metrykę (w danym kanale); kilka albo żadne — brak źródła. */
export function singleSource<T extends MetricSourceDevice>(
  devices: readonly T[],
  metric: string,
  channel: number | null = null,
): Source<T> {
  const sources = devices.filter((d) => d.enabled && d.metrics.some((m) => m.key === metric && m.channel === channel))
  const [device] = sources
  if (!device) return { kind: 'none' }
  return sources.length > 1 ? { kind: 'many', count: sources.length } : { kind: 'one', device }
}

export type SiteValue =
  | {
      kind: 'value'
      value: number
      ageSeconds: number
      stale: boolean
      origin: LiveOrigin
      deviceName: string
    }
  | { kind: 'no-data'; ageSeconds: number | null }
  | { kind: 'not-provided' }
  | { kind: 'ambiguous'; sources: number }

/** Kanały metryki (string MPPT, faza) podawane przez włączone urządzenia, rosnąco. */
export function metricChannels(devices: readonly MetricSourceDevice[], metric: string): number[] {
  const channels = new Set<number>()
  for (const d of devices) {
    if (!d.enabled) continue
    for (const m of d.metrics) if (m.key === metric && m.channel !== null) channels.add(m.channel)
  }
  return [...channels].toSorted((a, b) => a - b)
}

export function siteValue(
  devices: readonly LiveDevice[],
  readings: ReadingMap,
  metric: string,
  now: Date,
  channel: number | null = null,
): SiteValue {
  const source = singleSource(devices, metric, channel)
  if (source.kind === 'none') return { kind: 'not-provided' }
  if (source.kind === 'many') return { kind: 'ambiguous', sources: source.count }
  const { device } = source
  const reading = readings.get(readingKey(device.id, metric, channel))
  if (!reading) return { kind: 'no-data', ageSeconds: null }
  // Zegar przeglądarki może się różnić od serwera — wiek nie bywa ujemny.
  const ageSeconds = Math.max(0, (now.getTime() - Date.parse(reading.receivedAt)) / 1000)
  if (reading.quality !== 'GOOD' || reading.value === null) return { kind: 'no-data', ageSeconds }
  return {
    kind: 'value',
    value: reading.value,
    ageSeconds,
    stale: ageSeconds > device.freshnessThresholdSeconds,
    origin: reading.origin,
    deviceName: device.name,
  }
}
