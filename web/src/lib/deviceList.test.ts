import { describe, expect, it } from 'vitest'
import type { ApiDevice } from '../api/devices'
import { chartMetrics, filterDevices, NO_FILTER, presentKinds, spanRange, statusCounts, statusGroup } from './deviceList'

function device(over: Partial<ApiDevice>): ApiDevice {
  return {
    id: 'd',
    name: 'Urządzenie',
    kind: 'INVERTER',
    manufacturer: null,
    model: null,
    enabled: true,
    status: 'OK',
    lastSuccessAt: null,
    agentId: null,
    details: null,
    metrics: [],
    supportLevel: null,
    ...over,
  }
}

const metric = (key: string, unit: string, channel: number | null = null, cumulative = false) => ({
  key,
  channel,
  name: key,
  unit,
  cumulative,
})

describe('lib/deviceList', () => {
  it('grupy statusów: nieaktualne i błąd to „wymaga uwagi”; nigdy „offline”', () => {
    expect(statusGroup('OK')).toBe('OK')
    expect(statusGroup('STALE')).toBe('ATTENTION')
    expect(statusGroup('ERROR')).toBe('ATTENTION')
    expect(statusGroup('UNKNOWN')).toBe('UNKNOWN')
    expect(statusGroup('DISABLED')).toBe('DISABLED')
    const list = [device({ status: 'OK' }), device({ status: 'ERROR' }), device({ status: 'STALE' }), device({ status: 'UNKNOWN' })]
    expect(statusCounts(list)).toEqual({ OK: 1, ATTENTION: 2, UNKNOWN: 1, DISABLED: 0 })
  })

  it('wyszukiwanie bez wielkości liter po nazwie, typie, producencie, modelu i adresie', () => {
    const meter = device({ id: 'm', name: 'Licznik', kind: 'METER', manufacturer: 'Eastron', model: 'SDM630' })
    const inverter = device({
      id: 'i',
      name: 'Falownik dach',
      details: {
        firmwareVersion: null,
        serialNumber: null,
        profileId: null,
        profileVersion: null,
        connection: { id: 'c', name: 'L', host: '192.168.1.50', port: 502, unitId: 1, pollIntervalSeconds: null, liveIntervalSeconds: null },
      },
    })
    const all = [meter, inverter]
    const ids = (query: string) => filterDevices(all, { ...NO_FILTER, query }).map((d) => d.id)
    expect(ids('')).toEqual(['m', 'i'])
    expect(ids('  sdm630 ')).toEqual(['m'])
    expect(ids('LICZNIK')).toEqual(['m'])
    expect(ids('falownik')).toEqual(['i']) // nazwa i etykieta typu
    expect(ids('192.168.1.50')).toEqual(['i'])
    expect(ids('brak')).toEqual([])
    expect(filterDevices(all, { ...NO_FILTER, kind: 'METER' }).map((d) => d.id)).toEqual(['m'])
  })

  it('typy w kolejności etykiet, nieznane na końcu', () => {
    expect(presentKinds([device({ kind: 'X_NEW' }), device({ kind: 'METER' }), device({ kind: 'INVERTER' })])).toEqual([
      'INVERTER',
      'METER',
      'X_NEW',
    ])
  })

  it('metryki wykresu: bez liczników energii, najpierw moc bez kanału', () => {
    const d = device({
      metrics: [
        metric('pv_energy_total', 'Wh', null, true),
        metric('battery_soc', '%'),
        metric('pv_string_power', 'W', 1),
        metric('pv_power', 'W'),
      ],
    })
    expect(chartMetrics(d).map((m) => m.key)).toEqual(['pv_power', 'pv_string_power', 'battery_soc'])
    expect(chartMetrics(device({ metrics: [metric('e', 'Wh', null, true)] }))).toEqual([])
  })

  it('zakres wykresu kroczący od teraz', () => {
    const now = new Date('2026-11-07T12:00:00Z')
    expect(spanRange('24h', now).from.toISOString()).toBe('2026-11-06T12:00:00.000Z')
    expect(spanRange('30d', now).from.toISOString()).toBe('2026-10-08T12:00:00.000Z')
    expect(spanRange('7d', now).to).toBe(now)
  })
})
