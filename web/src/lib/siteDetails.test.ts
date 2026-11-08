import { describe, expect, it } from 'vitest'
import type { LiveDevice, LiveReading } from '../api/live'
import { mergeReadings } from './liveValues'
import {
  availableEnergyWh,
  cellVoltageSpread,
  detailSections,
  phaseLabel,
  sectionNumber,
  type DetailSection,
} from './siteDetails'

const NOW = new Date('2026-11-07T12:00:00Z')

type M = [key: string, channel?: number]

function device(id: string, metrics: M[], enabled = true): LiveDevice {
  return {
    id,
    name: id,
    kind: 'INVERTER',
    enabled,
    freshnessThresholdSeconds: 60,
    metrics: metrics.map(([key, channel]) => ({ key, channel: channel ?? null, name: key, unit: '', cumulative: false })),
  }
}

function reading(deviceId: string, metric: string, value: number | null, channel: number | null = null, secondsAgo = 5): LiveReading {
  return {
    deviceId,
    metric,
    channel,
    value,
    quality: value === null ? 'MISSING' : 'GOOD',
    origin: 'DEVICE',
    receivedAt: new Date(NOW.getTime() - secondsAgo * 1000).toISOString(),
  }
}

const sections = (devices: LiveDevice[], readings: LiveReading[]) =>
  detailSections(devices, mergeReadings(new Map(), readings), NOW)

const shown = (r: DetailSection['groups'][number]['rows'][number] | null) =>
  r === null ? null : r.value.kind === 'value' ? r.value.value : r.value.kind

/** Skrót: tytuł grupy → etykieta wiersza → wartość albo rodzaj braku. */
function summary(s: DetailSection) {
  return s.groups.map((g) => ({
    title: g.title,
    rows: g.rows.map((r) => [r.label, shown(r)]),
  }))
}

/** Skrót tabeli faz: etykieta → [napięcie, prąd] (null — metryka nieudostępniana). */
const phases = (s: DetailSection) => s.phases.map((p) => [p.label, shown(p.voltage), shown(p.current)])

describe('detailSections', () => {
  it('profil symulatora: tylko udostępniane metryki, string bez wyliczonej mocy', () => {
    const inv = device('inv', [
      ['pv_power'],
      ['pv_string_voltage', 1],
      ['pv_string_current', 1],
      ['inverter_temperature'],
      ['battery_power'],
      ['battery_soc'],
      ['grid_power'],
      ['grid_frequency'],
    ])
    const out = sections(
      [inv],
      [
        reading('inv', 'pv_power', 3200),
        reading('inv', 'pv_string_voltage', 410.5, 1),
        reading('inv', 'pv_string_current', 7.8, 1),
        reading('inv', 'battery_soc', 64),
        reading('inv', 'battery_power', -1500),
        reading('inv', 'grid_power', 200),
        reading('inv', 'grid_frequency', 50.01),
      ],
    )
    expect(out.map((s) => s.key)).toEqual(['pv', 'battery', 'grid'])
    const [pv, battery, grid] = out
    expect(summary(pv!)).toEqual([
      { title: null, rows: [['Moc całkowita', 3200], ['Temperatura falownika', 'no-data']] },
      { title: 'MPPT 1', rows: [['Napięcie', 410.5], ['Prąd', 7.8]] },
    ])
    expect(summary(battery!)).toEqual([{ title: null, rows: [['Stan naładowania', 64], ['Moc', -1500]] }])
    expect(summary(grid!)).toEqual([{ title: null, rows: [['Moc', 200], ['Częstotliwość', 50.01]] }])
    expect(battery!.groups[0]!.rows[1]!.signed).toEqual({ positive: 'rozładowanie', negative: 'ładowanie' })
    expect(grid!.groups[0]!.rows[0]!.signed).toEqual({ positive: 'pobór z sieci', negative: 'oddawanie do sieci' })
  })

  it('bez baterii i bez metryk sieci — tych paneli nie ma', () => {
    const out = sections([device('inv', [['pv_power']])], [reading('inv', 'pv_power', 100)])
    expect(out.map((s) => s.key)).toEqual(['pv'])
  })

  it('nic nie jest udostępniane — brak paneli', () => {
    expect(sections([device('inv', [])], [])).toEqual([])
  })

  it('wyłączone urządzenie nie jest źródłem', () => {
    expect(sections([device('inv', [['battery_soc']], false)], [reading('inv', 'battery_soc', 50)])).toEqual([])
  })

  it('stringi i fazy osobno na kanał, rosnąco; etykiety faz L1–L3', () => {
    const inv = device('inv', [
      ['pv_string_power', 2],
      ['pv_string_power', 1],
      ['pv_string_voltage', 2],
      ['grid_voltage', 3],
      ['grid_voltage', 1],
      ['grid_voltage', 2],
    ])
    const out = sections(
      [inv],
      [
        reading('inv', 'pv_string_power', 1000, 1),
        reading('inv', 'pv_string_power', 900, 2),
        reading('inv', 'pv_string_voltage', 380, 2),
        reading('inv', 'grid_voltage', 231, 1),
        reading('inv', 'grid_voltage', 229, 2),
        reading('inv', 'grid_voltage', 233, 3),
      ],
    )
    const [pv, grid] = out
    expect(summary(pv!)).toEqual([
      { title: 'MPPT 1', rows: [['Moc', 1000]] },
      { title: 'MPPT 2', rows: [['Moc', 900], ['Napięcie', 380]] },
    ])
    expect(pv!.groups.map((g) => g.channel)).toEqual([1, 2])
    expect(summary(grid!)).toEqual([])
    expect(phases(grid!)).toEqual([
      ['L1', 231, null],
      ['L2', 229, null],
      ['L3', 233, null],
    ])
  })

  it('odczyt kanału nie miesza się z innym kanałem ani z wartością bez kanału', () => {
    const inv = device('inv', [['grid_voltage', 1], ['grid_voltage', 2]])
    const [grid] = sections([inv], [reading('inv', 'grid_voltage', 230, 1), reading('inv', 'grid_voltage', 999, null)])
    expect(phases(grid!)).toEqual([
      ['L1', 230, null],
      ['L2', 'no-data', null],
    ])
  })

  it('brak odczytu i MISSING to brak danych, nigdy 0; nieaktualny odczyt oznaczony', () => {
    const inv = device('inv', [['battery_soc'], ['battery_voltage'], ['battery_temperature']])
    const [battery] = sections(
      [inv],
      [reading('inv', 'battery_soc', null), reading('inv', 'battery_voltage', 52.1, null, 120)],
    )
    const rows = battery!.groups[0]!.rows
    expect(rows.map((r) => r.value.kind)).toEqual(['no-data', 'value', 'no-data'])
    expect(rows[1]!.value).toMatchObject({ kind: 'value', stale: true })
  })

  it('dwa urządzenia podające ten sam kanał — wiele źródeł, bez sumowania (D50)', () => {
    const a = device('a', [['pv_string_power', 1], ['pv_string_power', 2]])
    const b = device('b', [['pv_string_power', 1]])
    const [pv] = sections(
      [a, b],
      [reading('a', 'pv_string_power', 500, 1), reading('b', 'pv_string_power', 600, 1), reading('a', 'pv_string_power', 700, 2)],
    )
    expect(summary(pv!)).toEqual([
      { title: 'MPPT 1', rows: [['Moc', 'ambiguous']] },
      { title: 'MPPT 2', rows: [['Moc', 700]] },
    ])
  })

  it('prąd i napięcie faz w jednej tabeli; faza tylko z prądem też jest', () => {
    const meter = device('m', [['grid_voltage', 1], ['grid_current', 1], ['grid_current', 2], ['grid_power']])
    const [grid] = sections(
      [meter],
      [reading('m', 'grid_voltage', 230.4, 1), reading('m', 'grid_current', 3.1, 1), reading('m', 'grid_power', -800)],
    )
    expect(summary(grid!)).toEqual([{ title: null, rows: [['Moc', -800]] }])
    expect(phases(grid!)).toEqual([
      ['L1', 230.4, 3.1],
      ['L2', null, 'no-data'],
    ])
  })

  it('BMS: panel tylko z metrykami ogniw, napięcie ogniwa z 3 miejscami, cykle bez jednostki', () => {
    const bms = device('b', [
      ['battery_cell_voltage_min'],
      ['battery_cell_voltage_max'],
      ['battery_cell_temperature_max'],
      ['battery_cycle_count'],
    ])
    const out = sections(
      [bms],
      [reading('b', 'battery_cell_voltage_min', 3.301), reading('b', 'battery_cycle_count', 412)],
    )
    expect(out.map((s) => s.key)).toEqual(['bms'])
    const [section] = out
    expect(summary(section!)).toEqual([
      {
        title: null,
        rows: [
          ['Napięcie ogniwa min.', 3.301],
          ['Napięcie ogniwa maks.', 'no-data'],
          ['Temperatura ogniwa maks.', 'no-data'],
          ['Liczba cykli', 412],
        ],
      },
    ])
    const rows = section!.groups[0]!.rows
    expect(rows.map((r) => [r.unit, r.voltDigits])).toEqual([
      ['V', 3],
      ['V', 3],
      ['°C', 1],
      ['count', 1],
    ])
    expect(sectionNumber(section!, 'battery_cell_voltage_min')).toBe(3.301)
    expect(sectionNumber(section!, 'battery_cell_voltage_max')).toBeNull()
  })

  it('kolejność paneli: PV, magazyn, sieć, BMS; pojemność i temperatura modułów jako wiersze', () => {
    const inv = device('inv', [
      ['pv_module_temperature'],
      ['battery_capacity'],
      ['grid_frequency'],
      ['battery_cycle_count'],
    ])
    const out = sections([inv], [reading('inv', 'battery_capacity', 10_000), reading('inv', 'pv_module_temperature', 31)])
    expect(out.map((s) => s.key)).toEqual(['pv', 'battery', 'grid', 'bms'])
    expect(summary(out[0]!)).toEqual([{ title: null, rows: [['Temperatura modułów', 31]] }])
    expect(summary(out[1]!)).toEqual([{ title: null, rows: [['Pojemność nominalna', 10_000]] }])
  })

  it('phaseLabel', () => {
    expect([1, 2, 3, 4].map(phaseLabel)).toEqual(['L1', 'L2', 'L3', 'kanał 4'])
  })
})

describe('wartości wyliczone', () => {
  it('energia w magazynie = SoC × pojemność; brak lub błędna wartość — null', () => {
    expect(availableEnergyWh(69, 16_000)).toBeCloseTo(11_040)
    expect(availableEnergyWh(0, 10_000)).toBe(0)
    expect(availableEnergyWh(null, 10_000)).toBeNull()
    expect(availableEnergyWh(50, null)).toBeNull()
    expect(availableEnergyWh(120, 10_000)).toBeNull()
    expect(availableEnergyWh(50, 0)).toBeNull()
  })

  it('rozrzut napięć ogniw; niespójne dane (max < min) — null', () => {
    expect(cellVoltageSpread(3.31, 3.34)).toBeCloseTo(0.03)
    expect(cellVoltageSpread(null, 3.34)).toBeNull()
    expect(cellVoltageSpread(3.4, 3.3)).toBeNull()
  })
})
