import type { DeviceHealth, Measurement } from '../data/types'

/** Wiek pomiaru w sekundach; null, gdy brak czasu obserwacji. */
export function ageSeconds(observedAt: string | null, now: Date): number | null {
  if (observedAt === null) {
    return null
  }
  const t = Date.parse(observedAt)
  if (Number.isNaN(t)) {
    return null
  }
  return (now.getTime() - t) / 1000
}

/** Pomiar jest nieaktualny, gdy przekroczył próg świeżości, nie ma czasu albo źródło tak go oznaczyło. */
export function isStale(m: Measurement, now: Date, staleAfterSeconds: number): boolean {
  if (m.quality === 'STALE') {
    return true
  }
  const age = ageSeconds(m.observedAt, now)
  return age === null || age > staleAfterSeconds
}

/** Wartość nadaje się do prezentacji jako bieżąca (jest, jest ważna i świeża). */
export function isUsable(m: Measurement, now: Date, staleAfterSeconds: number): boolean {
  return (
    m.value !== null &&
    m.quality !== 'INVALID' &&
    m.quality !== 'MISSING' &&
    !isStale(m, now, staleAfterSeconds)
  )
}

export type DeviceStatus = 'ONLINE' | 'NO_RESPONSE' | 'UNKNOWN'

/**
 * Status wyliczany z polityki świeżości (docs/ARCHITECTURE.md):
 * - agent nieosiągalny → UNKNOWN (nie wiemy, co z urządzeniem; nie OFFLINE),
 * - świeży udany odczyt → ONLINE,
 * - agent działa, ale brak świeżego odczytu → NO_RESPONSE.
 */
export function deviceStatus(device: DeviceHealth, now: Date): DeviceStatus {
  if (!device.agentReachable) {
    return 'UNKNOWN'
  }
  const age = ageSeconds(device.lastSuccessAt, now)
  if (age !== null && age >= 0 && age <= device.freshnessThresholdSeconds) {
    return 'ONLINE'
  }
  return 'NO_RESPONSE'
}
