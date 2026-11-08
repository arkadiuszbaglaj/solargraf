/**
 * Panele szczegółów instalacji (D56, D69): Fotowoltaika, Magazyn energii, BMS, Sieć. Czyste funkcje.
 *
 * - Wiersz istnieje tylko dla metryki (i kanału), którą profil włączonego urządzenia udostępnia;
 *   panel bez wierszy jest pomijany. Metryka dostarczana bez odczytu → „brak danych”, nigdy 0.
 * - Wartości z reguły jednego źródła (D50), także osobno dla każdego kanału.
 * - Wiersze to tylko zmierzone wartości. Wyliczenia (energia dostępna, rozrzut napięć ogniw) są
 *   osobnymi funkcjami, a UI oznacza je jako szacunek albo wartość wyliczoną.
 * - Znak D39: sieć + pobór / − oddawanie; bateria + rozładowanie / − ładowanie (moc i prąd).
 */
import type { LiveDevice } from '../api/live'
import type { Unit } from '../data/types'
import { metricChannels, siteValue, type ReadingMap, type SiteValue } from './liveValues'

export type DetailKey = 'pv' | 'battery' | 'bms' | 'grid'

export interface DetailRow {
  /** Stabilny klucz wiersza: metryka i kanał. */
  id: string
  label: string
  unit: Unit
  value: SiteValue
  /** Opisy kierunku dla wartości ze znakiem (D39); null — wartość bez kierunku. */
  signed: { positive: string; negative: string } | null
  /** Miejsca po przecinku dla V (napięcie ogniwa — 3); domyślnie 1. */
  voltDigits: number
}

export interface DetailGroup {
  /** Nagłówek grupy (np. „MPPT 1”); null — wiersze bez podtytułu. */
  title: string | null
  /** Kanał grupy (numer stringu MPPT); null — grupa bez kanału. */
  channel: number | null
  rows: DetailRow[]
}

/** Wiersz tabeli faz sieci: napięcie i prąd jednej fazy (metryka nieudostępniana — null). */
export interface PhaseRow {
  channel: number
  label: string
  voltage: DetailRow | null
  current: DetailRow | null
}

export interface DetailSection {
  key: DetailKey
  title: string
  groups: DetailGroup[]
  /** Fazy sieci (tylko sekcja „Sieć”); pusta lista — brak metryk fazowych. */
  phases: PhaseRow[]
}

interface RowSpec {
  metric: string
  label: string
  unit: Unit
  signed?: DetailRow['signed']
  voltDigits?: number
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
  return {
    id: `${spec.metric}|${channel ?? 0}`,
    label,
    unit: spec.unit,
    value,
    signed: spec.signed ?? null,
    voltDigits: spec.voltDigits ?? 1,
  }
}

const present = <T>(items: ReadonlyArray<T | null>): T[] => items.filter((x): x is T => x !== null)

function group(
  title: string | null,
  rows: ReadonlyArray<DetailRow | null>,
  channel: number | null = null,
): DetailGroup | null {
  const kept = present(rows)
  return kept.length > 0 ? { title, channel, rows: kept } : null
}

function section(
  key: DetailKey,
  title: string,
  groups: ReadonlyArray<DetailGroup | null>,
  phases: PhaseRow[] = [],
): DetailSection | null {
  const kept = present(groups)
  return kept.length > 0 || phases.length > 0 ? { key, title, groups: kept, phases } : null
}

function pvSection(ctx: Context): DetailSection | null {
  const channels = [...new Set(STRING_ROWS.flatMap((s) => metricChannels(ctx.devices, s.metric)))].toSorted((a, b) => a - b)
  return section('pv', 'Fotowoltaika', [
    group(null, [
      row(ctx, { metric: 'pv_power', label: 'Moc całkowita', unit: 'W' }),
      row(ctx, { metric: 'inverter_temperature', label: 'Temperatura falownika', unit: '°C' }),
      row(ctx, { metric: 'pv_module_temperature', label: 'Temperatura modułów', unit: '°C' }),
    ]),
    ...channels.map((ch) => group(`MPPT ${ch}`, STRING_ROWS.map((s) => row(ctx, s, ch)), ch)),
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
      row(ctx, { metric: 'battery_capacity', label: 'Pojemność nominalna', unit: 'Wh' }),
    ]),
  ])
}

function bmsSection(ctx: Context): DetailSection | null {
  return section('bms', 'BMS — ogniwa', [
    group(null, [
      row(ctx, { metric: 'battery_cell_voltage_min', label: 'Napięcie ogniwa min.', unit: 'V', voltDigits: 3 }),
      row(ctx, { metric: 'battery_cell_voltage_max', label: 'Napięcie ogniwa maks.', unit: 'V', voltDigits: 3 }),
      row(ctx, { metric: 'battery_cell_temperature_min', label: 'Temperatura ogniwa min.', unit: '°C' }),
      row(ctx, { metric: 'battery_cell_temperature_max', label: 'Temperatura ogniwa maks.', unit: '°C' }),
      row(ctx, { metric: 'battery_cycle_count', label: 'Liczba cykli', unit: 'count' }),
    ]),
  ])
}

function gridSection(ctx: Context): DetailSection | null {
  const voltage: RowSpec = { metric: 'grid_voltage', label: 'Napięcie', unit: 'V' }
  const current: RowSpec = { metric: 'grid_current', label: 'Prąd', unit: 'A' }
  const channels = [
    ...new Set([...metricChannels(ctx.devices, voltage.metric), ...metricChannels(ctx.devices, current.metric)]),
  ].toSorted((a, b) => a - b)
  const phases = channels
    .map(
      (ch): PhaseRow => ({
        channel: ch,
        label: phaseLabel(ch),
        voltage: row(ctx, voltage, ch, `Napięcie ${phaseLabel(ch)}`),
        current: row(ctx, current, ch, `Prąd ${phaseLabel(ch)}`),
      }),
    )
    .filter((p) => p.voltage !== null || p.current !== null)
  return section(
    'grid',
    'Sieć',
    [
      group(null, [
        row(ctx, { metric: 'grid_power', label: 'Moc', unit: 'W', signed: GRID_DIRECTION }),
        row(ctx, { metric: 'grid_frequency', label: 'Częstotliwość', unit: 'Hz' }),
      ]),
    ],
    phases,
  )
}

/** Panele szczegółów w stałej kolejności; tylko te, dla których profil coś udostępnia. */
export function detailSections(devices: readonly LiveDevice[], readings: ReadingMap, now: Date): DetailSection[] {
  const ctx = { devices, readings, now }
  return present([pvSection(ctx), batterySection(ctx), gridSection(ctx), bmsSection(ctx)])
}

/** Wszystkie wartości sekcji (np. do oznaczenia SIMULATED albo wieku najstarszego odczytu). */
export const sectionValues = (s: DetailSection): SiteValue[] => [
  ...s.groups.flatMap((g) => g.rows.map((r) => r.value)),
  ...s.phases.flatMap((p) => present([p.voltage, p.current]).map((r) => r.value)),
]

/** Bieżąca wartość metryki bez kanału z wierszy sekcji; brak wiersza albo odczytu — null. */
export function sectionNumber(s: DetailSection, metric: string): number | null {
  const found = s.groups.flatMap((g) => g.rows).find((r) => r.id === `${metric}|0`)
  return found?.value.kind === 'value' ? found.value.value : null
}

/**
 * Szacunek energii w baterii: SoC × pojemność nominalna [Wh]. Brak którejkolwiek wartości albo
 * wartość spoza zakresu — null (UI nie pokazuje szacunku). Nie uwzględnia rezerwy ani starzenia.
 */
export function availableEnergyWh(socPercent: number | null, capacityWh: number | null): number | null {
  if (socPercent === null || capacityWh === null) return null
  if (socPercent < 0 || socPercent > 100 || capacityWh <= 0) return null
  return (socPercent / 100) * capacityWh
}

/** Rozrzut napięć ogniw (maks. − min.) [V]; null bez obu wartości albo przy niespójnych danych. */
export function cellVoltageSpread(min: number | null, max: number | null): number | null {
  if (min === null || max === null || max < min) return null
  return max - min
}

/** Poniżej tej mocy baterii nie szacujemy czasu (spoczynek; jak próg strzałki przepływu D54). */
export const BATTERY_IDLE_W = 50
/** Największa różnica wieku odczytów SoC i mocy, przy której szacunek ma sens (jak bilans D54). */
export const BATTERY_MAX_SPREAD_S = 30

export type BatteryTime =
  | { kind: 'charging'; seconds: number }
  | { kind: 'discharging'; seconds: number }
  | { kind: 'full' }
  | { kind: 'empty' }
  | { kind: 'idle' }

/** Wartość metryki bez kanału z sekcji (cały wynik `siteValue`, z wiekiem i świeżością). */
export function sectionValue(s: DetailSection, metric: string): SiteValue | null {
  return s.groups.flatMap((g) => g.rows).find((r) => r.id === `${metric}|0`)?.value ?? null
}

/**
 * Szacunkowy czas do pełnego naładowania (ładowanie) albo do rozładowania (rozładowanie) przy
 * obecnej mocy: energia brakująca do 100% SoC albo pozostała do 0% SoC ÷ |moc|. Znak mocy wg D39:
 * dodatnia = rozładowanie. Bez szacunku (null), gdy brakuje SoC, mocy albo pojemności, odczyt jest
 * nieaktualny, odczyty SoC i mocy dzieli więcej niż `BATTERY_MAX_SPREAD_S` albo wartość jest spoza
 * zakresu. Rezerwa falownika i sprawność ładowania nie są uwzględnione.
 */
export function batteryTime(
  soc: SiteValue | null,
  power: SiteValue | null,
  capacityWh: number | null,
): BatteryTime | null {
  if (soc?.kind !== 'value' || power?.kind !== 'value' || capacityWh === null) return null
  if (soc.stale || power.stale || Math.abs(soc.ageSeconds - power.ageSeconds) > BATTERY_MAX_SPREAD_S) return null
  if (soc.value < 0 || soc.value > 100 || capacityWh <= 0 || !Number.isFinite(power.value)) return null
  if (Math.abs(power.value) < BATTERY_IDLE_W) return { kind: 'idle' }
  if (power.value < 0) {
    if (soc.value >= 100) return { kind: 'full' }
    return { kind: 'charging', seconds: (((100 - soc.value) / 100) * capacityWh * 3600) / -power.value }
  }
  if (soc.value <= 0) return { kind: 'empty' }
  return { kind: 'discharging', seconds: ((soc.value / 100) * capacityWh * 3600) / power.value }
}

/** Czas szacunku po polsku: „ok. 1 h 20 min”, „ok. 45 min”, „poniżej minuty”, „ponad 99 h”. */
export function formatEstimate(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  if (minutes < 1) return 'poniżej minuty'
  if (minutes > 99 * 60) return 'ponad 99 h'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `ok. ${m} min`
  return m === 0 ? `ok. ${h} h` : `ok. ${h} h ${m} min`
}
