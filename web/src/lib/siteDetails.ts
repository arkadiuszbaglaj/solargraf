/**
 * Panele szczegółów instalacji (D56): Fotowoltaika, Magazyn energii, Sieć. Czyste funkcje.
 *
 * - Wiersz istnieje tylko dla metryki (i kanału), którą profil włączonego urządzenia udostępnia;
 *   panel bez wierszy jest pomijany. Metryka dostarczana bez odczytu → „brak danych”, nigdy 0.
 * - Wartości z reguły jednego źródła (D50), także osobno dla każdego kanału.
 * - Nic nie jest wyliczane (np. moc stringu z V×I) — tylko zmierzone wartości.
 * - Znak D39: sieć + pobór / − oddawanie; bateria + rozładowanie / − ładowanie (moc i prąd).
 */
import type { LiveDevice } from '../api/live'
import type { Unit } from '../data/types'
import { metricChannels, siteValue, type ReadingMap, type SiteValue } from './liveValues'

export type DetailKey = 'pv' | 'battery' | 'grid'

export interface DetailRow {
  /** Stabilny klucz wiersza: metryka i kanał. */
  id: string
  label: string
  unit: Unit
  value: SiteValue
  /** Opisy kierunku dla wartości ze znakiem (D39); null — wartość bez kierunku. */
  signed: { positive: string; negative: string } | null
}

export interface DetailGroup {
  /** Nagłówek grupy (np. „String 1”); null — wiersze bez podtytułu. */
  title: string | null
  rows: DetailRow[]
}

export interface DetailSection {
  key: DetailKey
  title: string
  groups: DetailGroup[]
}

interface RowSpec {
  metric: string
  label: string
  unit: Unit
  signed?: DetailRow['signed']
}

const BATTERY_DIRECTION = { positive: 'rozładowanie', negative: 'ładowanie' }
const GRID_DIRECTION = { positive: 'pobór z sieci', negative: 'oddawanie do sieci' }

const STRING_ROWS: RowSpec[] = [
  { metric: 'pv_string_power', label: 'Moc', unit: 'W' },
  { metric: 'pv_string_voltage', label: 'Napięcie', unit: 'V' },
  { metric: 'pv_string_current', label: 'Prąd', unit: 'A' },
]

/** Etykieta fazy z kanału metryki sieciowej: 1–3 → L1–L3, inne numery bez zgadywania. */
export const phaseLabel = (channel: number): string => (channel >= 1 && channel <= 3 ? `L${channel}` : `kanał ${channel}`)

interface Context {
  devices: readonly LiveDevice[]
  readings: ReadingMap
  now: Date
}

function row(ctx: Context, spec: RowSpec, channel: number | null = null, label = spec.label): DetailRow | null {
  const value = siteValue(ctx.devices, ctx.readings, spec.metric, ctx.now, channel)
  if (value.kind === 'not-provided') return null
  return { id: `${spec.metric}|${channel ?? 0}`, label, unit: spec.unit, value, signed: spec.signed ?? null }
}

const present = <T>(items: ReadonlyArray<T | null>): T[] => items.filter((x): x is T => x !== null)

function group(title: string | null, rows: ReadonlyArray<DetailRow | null>): DetailGroup | null {
  const kept = present(rows)
  return kept.length > 0 ? { title, rows: kept } : null
}

function section(key: DetailKey, title: string, groups: ReadonlyArray<DetailGroup | null>): DetailSection | null {
  const kept = present(groups)
  return kept.length > 0 ? { key, title, groups: kept } : null
}

function pvSection(ctx: Context): DetailSection | null {
  const channels = [...new Set(STRING_ROWS.flatMap((s) => metricChannels(ctx.devices, s.metric)))].toSorted((a, b) => a - b)
  return section('pv', 'Fotowoltaika', [
    group(null, [
      row(ctx, { metric: 'pv_power', label: 'Moc całkowita', unit: 'W' }),
      row(ctx, { metric: 'inverter_temperature', label: 'Temperatura falownika', unit: '°C' }),
    ]),
    ...channels.map((ch) => group(`String ${ch}`, STRING_ROWS.map((s) => row(ctx, s, ch)))),
  ])
}

function batterySection(ctx: Context): DetailSection | null {
  return section('battery', 'Magazyn energii', [
    group(null, [
      row(ctx, { metric: 'battery_soc', label: 'Stan naładowania', unit: '%' }),
      row(ctx, { metric: 'battery_power', label: 'Moc', unit: 'W', signed: BATTERY_DIRECTION }),
      row(ctx, { metric: 'battery_voltage', label: 'Napięcie', unit: 'V' }),
      row(ctx, { metric: 'battery_current', label: 'Prąd', unit: 'A', signed: BATTERY_DIRECTION }),
      row(ctx, { metric: 'battery_temperature', label: 'Temperatura', unit: '°C' }),
    ]),
  ])
}

function gridSection(ctx: Context): DetailSection | null {
  const voltage: RowSpec = { metric: 'grid_voltage', label: 'Napięcie', unit: 'V' }
  return section('grid', 'Sieć', [
    group(null, [
      row(ctx, { metric: 'grid_power', label: 'Moc', unit: 'W', signed: GRID_DIRECTION }),
      ...metricChannels(ctx.devices, voltage.metric).map((ch) => row(ctx, voltage, ch, `Napięcie ${phaseLabel(ch)}`)),
      row(ctx, { metric: 'grid_frequency', label: 'Częstotliwość', unit: 'Hz' }),
    ]),
  ])
}

/** Panele szczegółów w stałej kolejności; tylko te, dla których profil coś udostępnia. */
export function detailSections(devices: readonly LiveDevice[], readings: ReadingMap, now: Date): DetailSection[] {
  const ctx = { devices, readings, now }
  return present([pvSection(ctx), batterySection(ctx), gridSection(ctx)])
}

/** Wszystkie wartości sekcji (np. do oznaczenia SIMULATED albo wieku najstarszego odczytu). */
export const sectionValues = (s: DetailSection): SiteValue[] => s.groups.flatMap((g) => g.rows.map((r) => r.value))
