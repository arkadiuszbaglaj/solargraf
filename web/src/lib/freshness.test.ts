import { describe, expect, it } from 'vitest'
import type { DeviceHealth, Measurement } from '../data/types'
import { ageSeconds, deviceStatus, isStale, isUsable } from './freshness'

const NOW = new Date('2026-11-07T12:00:00Z')

function m(overrides: Partial<Measurement> = {}): Measurement {
  return {
    value: 1000,
    unit: 'W',
    observedAt: '2026-11-07T11:59:30Z',
    quality: 'GOOD',
    origin: 'DEMO',
    ...overrides,
  }
}

function device(overrides: Partial<DeviceHealth> = {}): DeviceHealth {
  return {
    id: 'd',
    name: 'Falownik',
    kind: 'INVERTER',
    model: null,
    origin: 'DEMO',
    lastSuccessAt: '2026-11-07T11:59:50Z',
    freshnessThresholdSeconds: 60,
    agentReachable: true,
    ...overrides,
  }
}

describe('świeżość pomiaru', () => {
  it('wiek liczony od czasu obserwacji', () => {
    expect(ageSeconds('2026-11-07T11:59:30Z', NOW)).toBe(30)
    expect(ageSeconds(null, NOW)).toBeNull()
    expect(ageSeconds('nie-data', NOW)).toBeNull()
  })

  it('próg świeżości: równy progowi — aktualny, powyżej — nieaktualny', () => {
    expect(isStale(m({ observedAt: '2026-11-07T11:59:00Z' }), NOW, 60)).toBe(false)
    expect(isStale(m({ observedAt: '2026-11-07T11:58:59Z' }), NOW, 60)).toBe(true)
  })

  it('brak czasu obserwacji lub jakość STALE → nieaktualny', () => {
    expect(isStale(m({ observedAt: null }), NOW, 60)).toBe(true)
    expect(isStale(m({ quality: 'STALE' }), NOW, 60)).toBe(true)
  })

  it('wartość użyteczna tylko, gdy jest, jest ważna i świeża', () => {
    expect(isUsable(m(), NOW, 60)).toBe(true)
    expect(isUsable(m({ value: null, quality: 'MISSING' }), NOW, 60)).toBe(false)
    expect(isUsable(m({ quality: 'INVALID' }), NOW, 60)).toBe(false)
    expect(isUsable(m({ observedAt: '2026-11-07T11:00:00Z' }), NOW, 60)).toBe(false)
  })
})

describe('status urządzenia', () => {
  it('świeży odczyt przy działającym agencie → ONLINE', () => {
    expect(deviceStatus(device(), NOW)).toBe('ONLINE')
  })

  it('agent nieosiągalny → UNKNOWN, nawet przy niedawnym odczycie', () => {
    expect(deviceStatus(device({ agentReachable: false }), NOW)).toBe('UNKNOWN')
  })

  it('agent działa, odczyt starszy niż próg → NO_RESPONSE', () => {
    expect(deviceStatus(device({ lastSuccessAt: '2026-11-07T11:50:00Z' }), NOW)).toBe('NO_RESPONSE')
  })

  it('nigdy nieodczytane → NO_RESPONSE, nie ONLINE', () => {
    expect(deviceStatus(device({ lastSuccessAt: null }), NOW)).toBe('NO_RESPONSE')
  })

  it('odczyt z przyszłości (zły zegar) nie potwierdza ONLINE', () => {
    expect(deviceStatus(device({ lastSuccessAt: '2026-11-07T12:05:00Z' }), NOW)).toBe('NO_RESPONSE')
  })
})
