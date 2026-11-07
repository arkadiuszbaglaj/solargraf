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

export function siteValue(
  devices: readonly LiveDevice[],
  readings: ReadingMap,
  metric: string,
  now: Date,
): SiteValue {
  const sources = devices.filter(
    (d) => d.enabled && d.metrics.some((m) => m.key === metric && m.channel === null),
  )
  const [device] = sources
  if (!device) return { kind: 'not-provided' }
  if (sources.length > 1) return { kind: 'ambiguous', sources: sources.length }
  const reading = readings.get(readingKey(device.id, metric, null))
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
