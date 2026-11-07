import { describe, expect, it } from 'vitest'
import type { LiveDevice, LiveReading } from '../api/live'
import { mergeReadings, siteValue } from './liveValues'

const NOW = new Date('2026-11-07T12:00:00Z')

function device(id: string, metrics: string[], enabled = true): LiveDevice {
  return {
    id,
    name: `Urządzenie ${id}`,
    kind: 'INVERTER',
    enabled,
    freshnessThresholdSeconds: 300,
    metrics: metrics.map((key) => ({ key, channel: null, name: key, unit: 'W', cumulative: false })),
  }
}

function reading(deviceId: string, metric: string, secondsAgo: number, value: number | null = 1500): LiveReading {
  return {
    deviceId,
    metric,
    channel: null,
    value,
    quality: value === null ? 'MISSING' : 'GOOD',
    origin: 'DEVICE',
    receivedAt: new Date(NOW.getTime() - secondsAgo * 1000).toISOString(),
  }
}

describe('mergeReadings', () => {
  it('zostawia najnowszy odczyt każdej metryki, starszy nie nadpisuje nowszego', () => {
    const first = mergeReadings(new Map(), [reading('a', 'pv_power', 10, 100)])
    const next = mergeReadings(first, [reading('a', 'pv_power', 60, 50), reading('a', 'load_power', 5, 70)])
    expect(next.size).toBe(2)
    expect([...next.values()].find((r) => r.metric === 'pv_power')?.value).toBe(100)
    expect(first.size).toBe(1) // bez mutacji poprzedniej mapy
  })
})

describe('siteValue', () => {
  it('jedno źródło: wartość z wiekiem i progiem świeżości urządzenia', () => {
    const devices = [device('a', ['pv_power'])]
    const fresh = siteValue(devices, mergeReadings(new Map(), [reading('a', 'pv_power', 12)]), 'pv_power', NOW)
    expect(fresh).toEqual({
      kind: 'value',
      value: 1500,
      ageSeconds: 12,
      stale: false,
      origin: 'DEVICE',
      deviceName: 'Urządzenie a',
    })
    const old = siteValue(devices, mergeReadings(new Map(), [reading('a', 'pv_power', 301)]), 'pv_power', NOW)
    expect(old.kind === 'value' && old.stale).toBe(true)
  })

  it('brak odczytu i MISSING to brak danych, nigdy zero', () => {
    const devices = [device('a', ['pv_power'])]
    expect(siteValue(devices, new Map(), 'pv_power', NOW)).toEqual({ kind: 'no-data', ageSeconds: null })
    const missing = mergeReadings(new Map(), [reading('a', 'pv_power', 3, null)])
    expect(siteValue(devices, missing, 'pv_power', NOW)).toEqual({ kind: 'no-data', ageSeconds: 3 })
  })

  it('kilka źródeł tej samej metryki: wartość niedostępna, bez sumowania', () => {
    const devices = [device('a', ['grid_power']), device('b', ['grid_power'])]
    const readings = mergeReadings(new Map(), [reading('a', 'grid_power', 1), reading('b', 'grid_power', 1)])
    expect(siteValue(devices, readings, 'grid_power', NOW)).toEqual({ kind: 'ambiguous', sources: 2 })
  })

  it('urządzenie wyłączone nie jest źródłem; brak źródła to parametr niedostępny', () => {
    const devices = [device('a', ['grid_power'], false), device('b', ['pv_power'])]
    expect(siteValue(devices, new Map(), 'grid_power', NOW)).toEqual({ kind: 'not-provided' })
  })

  it('odczyt z przyszłości (różnica zegarów) ma wiek 0', () => {
    const devices = [device('a', ['pv_power'])]
    const v = siteValue(devices, mergeReadings(new Map(), [reading('a', 'pv_power', -20)]), 'pv_power', NOW)
    expect(v.kind === 'value' && v.ageSeconds).toBe(0)
  })
})
