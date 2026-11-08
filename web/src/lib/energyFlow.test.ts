import { describe, expect, it } from 'vitest'
import {
  balance,
  flowDirection,
  flowMotion,
  flowView,
  IDLE_W,
  MOTION_FAST_S,
  MOTION_MAX_W,
  MOTION_SLOW_S,
  MOTION_THICK,
  MOTION_THIN,
  type FlowInputs,
} from './energyFlow'
import type { SiteValue } from './liveValues'

const v = (value: number, ageSeconds = 5, stale = false): SiteValue => ({
  kind: 'value',
  value,
  ageSeconds,
  stale,
  origin: 'DEVICE',
  deviceName: 'Falownik',
})
const NOT_PROVIDED: SiteValue = { kind: 'not-provided' }

// Południe: PV 4 kW, dom 1 kW, ładowanie 2 kW, oddawanie 1 kW — bilans 4 = 1 + 2 + 1.
const NOON: FlowInputs = { pv: v(4000), home: v(1000), battery: v(-2000), grid: v(-1000) }

describe('flowDirection (znak D39, względem instalacji)', () => {
  it.each([
    ['pv', 3000, 'in'],
    ['home', 800, 'out'],
    ['grid', 500, 'in'],
    ['grid', -500, 'out'],
    ['battery', 1200, 'in'],
    ['battery', -1200, 'out'],
    ['battery', 49, 'idle'],
    ['grid', -49.9, 'idle'],
    ['pv', 50, 'in'],
  ] as const)('%s %d W → %s', (key, watts, dir) => {
    expect(flowDirection(key, watts)).toBe(dir)
  })
})

describe('flowMotion (prędkość i grubość animacji, D64)', () => {
  it.each([0, 49.9, -49.9, Number.NaN, Number.POSITIVE_INFINITY])('%d W → bez ruchu', (watts) => {
    expect(flowMotion(watts)).toBeNull()
  })

  it('na progu najwolniej i najciensze, od MOTION_MAX_W najszybciej i najgrubsze', () => {
    expect(flowMotion(IDLE_W)).toEqual({ durationS: MOTION_SLOW_S, width: MOTION_THIN })
    expect(flowMotion(MOTION_MAX_W)).toEqual({ durationS: MOTION_FAST_S, width: MOTION_THICK })
    expect(flowMotion(50_000)).toEqual({ durationS: MOTION_FAST_S, width: MOTION_THICK })
  })

  it('znak nie zmienia animacji (kierunek daje flowDirection)', () => {
    expect(flowMotion(-2000)).toEqual(flowMotion(2000))
  })

  it('skala logarytmiczna: większa moc — szybciej i grubiej', () => {
    // 50 W → 10 kW to 200×; 1 kW (20×) leży w ok. 57% skali.
    expect(flowMotion(1000)).toEqual({ durationS: 1.6, width: 6.5 })
    const powers = [100, 500, 2000, 5000]
    const motions = powers.map((w) => flowMotion(w))
    for (let i = 1; i < motions.length; i++) {
      expect(motions[i]!.durationS).toBeLessThan(motions[i - 1]!.durationS)
      expect(motions[i]!.width).toBeGreaterThanOrEqual(motions[i - 1]!.width)
    }
  })
})

describe('balance', () => {
  it('domknięty bilans południa i tolerancja 10% większej strony', () => {
    expect(balance({ pv: 4000, home: 1000, battery: -2000, grid: -1000 })).toEqual({ residual: 0, tolerance: 400 })
  })

  it('przy małych mocach tolerancja nie spada poniżej 150 W', () => {
    expect(balance({ pv: 0, home: 300, grid: 300 }).tolerance).toBe(150)
  })

  it('niespójność z makiety (falownik 4,56 kW + import 0,68 = 5,24 kW ≠ dom 3,12 + ładowanie 2,4 = 5,52 kW)', () => {
    // Różnica 280 W mieści się w tolerancji 552 W (10% z 5,52 kW) — straty i niesynchroniczność.
    expect(balance({ pv: 4560, grid: 680, home: 3120, battery: -2400 })).toEqual({ residual: -280, tolerance: 552 })
  })
})

describe('flowView', () => {
  it('spójny bilans: strzałki dla wszystkich węzłów, kierunki i opisy', () => {
    const view = flowView(NOON)
    expect(view.kind).toBe('flows')
    if (view.kind !== 'flows') return
    expect(view.arrows).toEqual({ pv: 'in', home: 'out', battery: 'out', grid: 'out' })
    expect(view.nodes.map((n) => [n.key, n.direction])).toEqual([
      ['pv', 'produkcja'],
      ['grid', 'oddawanie do sieci'],
      ['battery', 'ładowanie'],
      ['home', 'zużycie'],
    ])
  })

  it('noc bez baterii: PV poniżej progu bez strzałki, dom z sieci', () => {
    const view = flowView({ pv: v(0), home: v(400), grid: v(410), battery: NOT_PROVIDED })
    expect(view.kind).toBe('flows')
    if (view.kind !== 'flows') return
    expect(view.nodes.map((n) => n.key)).toEqual(['pv', 'grid', 'home'])
    expect(view.arrows).toEqual({ pv: 'idle', grid: 'in', home: 'out' })
    expect(view.nodes[0]?.direction).toBe('brak przepływu')
  })

  it('bilans się nie domyka → wartości bez strzałek z wielkością różnicy', () => {
    const view = flowView({ pv: v(4820), home: v(3120), grid: v(680), battery: NOT_PROVIDED })
    expect(view).toMatchObject({ kind: 'no-flows', reason: 'Bilans się nie domyka (różnica 2,38 kW) — przepływy nie są pokazywane.' })
  })

  it('brak źródła sieci, brak danych albo wartość nieaktualna → bez strzałek, z listą węzłów', () => {
    const view = flowView({ pv: v(4000, 5, true), home: { kind: 'no-data', ageSeconds: null }, grid: NOT_PROVIDED, battery: NOT_PROVIDED })
    expect(view).toMatchObject({
      kind: 'no-flows',
      reason: 'Przepływy nie są pokazywane — brak świeżych danych: Produkcja PV, Sieć, Zużycie domu.',
    })
    // Sieć bez źródła nadal jest węzłem (każdy dom ma sieć); bateria bez źródła — nie.
    expect(view.nodes.map((n) => n.key)).toEqual(['pv', 'grid', 'home'])
  })

  it('kilka źródeł baterii: węzeł widoczny, przepływy niepokazywane', () => {
    const view = flowView({ ...NOON, battery: { kind: 'ambiguous', sources: 2 } })
    expect(view.kind).toBe('no-flows')
    expect(view.nodes.map((n) => n.key)).toContain('battery')
  })

  it('odczyty z różnych chwil (ponad 30 s) → bez strzałek', () => {
    const view = flowView({ ...NOON, grid: v(-1000, 40) })
    expect(view).toMatchObject({ kind: 'no-flows', reason: 'Przepływy nie są pokazywane — odczyty z różnych chwil (różnica 35 s).' })
    expect(flowView({ ...NOON, grid: v(-1000, 35) }).kind).toBe('flows')
  })
})
