import { describe, expect, it } from 'vitest'
import { DemoDataSource } from './DemoDataSource'

// 12:00 czasu lokalnego (CET) — poza luką 13:00–13:45.
const NOON = new Date('2026-11-07T11:00:00Z')
// 13:20 czasu lokalnego — w luce.
const IN_GAP = new Date('2026-11-07T12:20:00Z')

function source(now: Date): DemoDataSource {
  return new DemoDataSource({ now: () => now, latencyMs: 0 })
}

describe('DemoDataSource', () => {
  it('wszystkie dane są oznaczone jako DEMO', async () => {
    const s = source(NOON)
    const kpis = await s.getKpis('demo-a')
    expect(s.origin).toBe('DEMO')
    expect(kpis.origin).toBe('DEMO')
    const origins = Object.values(kpis)
      .filter((v): v is { origin: string } => typeof v === 'object' && v !== null && 'origin' in v)
      .map((v) => v.origin)
    expect(origins.length).toBeGreaterThan(5)
    expect(new Set(origins)).toEqual(new Set(['DEMO']))
    expect((await s.getEnergyChart('demo-a')).origin).toBe('DEMO')
    expect((await s.getDevices('demo-a')).every((d) => d.origin === 'DEMO')).toBe(true)
    expect((await s.getAlarms('demo-a')).every((a) => a.origin === 'DEMO')).toBe(true)
  })

  it('bilans mocy domyka się: PV + sieć = dom + ładowanie', async () => {
    const k = await source(NOON).getKpis('demo-a')
    const [pv, grid, home, battery] = [k.pvPower, k.gridPower, k.homePower, k.batteryPower].map(
      (m) => m.value,
    ) as [number, number, number, number]
    expect(pv + grid).toBe(home + battery)
  })

  it('autokonsumpcja zgodna z D27 dla energii dziennych', async () => {
    const k = await source(NOON).getKpis('demo-a')
    const pv = k.todayPvEnergy.value ?? 0
    const exported = k.todayGridExportEnergy.value ?? 0
    expect(pv).toBeGreaterThan(0)
    expect(k.todaySelfConsumption.value).toBeCloseTo(((pv - exported) / pv) * 100, 0)
  })

  it('przed wschodem brak produkcji → autokonsumpcja jest brakiem danych, nie 0%', async () => {
    const k = await source(new Date('2026-11-07T04:00:00Z')).getKpis('demo-a')
    expect(k.todayPvEnergy.value).toBe(0)
    expect(k.todaySelfConsumption.value).toBeNull()
  })

  it('w luce bieżące wartości są null z jakością MISSING, a wykres ma null', async () => {
    const s = source(IN_GAP)
    const k = await s.getKpis('demo-a')
    expect(k.pvPower.value).toBeNull()
    expect(k.pvPower.quality).toBe('MISSING')
    const chart = await s.getEnergyChart('demo-a')
    const gapPoint = chart.pv.find(([t]) => t === '2026-11-07T12:00:00.000Z')
    expect(gapPoint?.[1]).toBeNull()
  })

  it('wykres zaczyna się od północy lokalnej i kończy na „teraz”', async () => {
    const chart = await source(NOON).getEnergyChart('demo-a')
    expect(chart.localDate).toBe('2026-11-07')
    expect(chart.pv[0]?.[0]).toBe('2026-11-06T23:00:00.000Z')
    expect(Date.parse(chart.pv.at(-1)?.[0] ?? '')).toBeLessThanOrEqual(NOON.getTime())
  })

  it('instalacja B: agent nieosiągalny — dane nieaktualne, urządzenia bez potwierdzenia', async () => {
    const s = source(NOON)
    const k = await s.getKpis('demo-b')
    const age = (NOON.getTime() - Date.parse(k.pvPower.observedAt ?? '')) / 1000
    expect(age).toBeGreaterThan(k.staleAfterSeconds)
    const devices = await s.getDevices('demo-b')
    expect(devices.every((d) => !d.agentReachable)).toBe(true)
    const alarms = await s.getAlarms('demo-b')
    expect(alarms[0]?.severity).toBe('CRITICAL')
  })

  it('nieznana instalacja kończy się błędem', async () => {
    await expect(source(NOON).getKpis('brak')).rejects.toThrow('Nieznana instalacja')
  })

  it('przerwanie żądania odrzuca obietnicę', async () => {
    const s = new DemoDataSource({ now: () => NOON, latencyMs: 50 })
    const controller = new AbortController()
    const pending = s.listSites(controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow('Przerwano')
  })
})
