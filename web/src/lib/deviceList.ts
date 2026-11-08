/**
 * Zakładka „Urządzenia”: wyszukiwanie, filtry, liczniki statusów i wybór metryki wykresu.
 * Czyste funkcje — bez UI i zegara. Status pochodzi z serwera (D38, D52); „offline” nie istnieje —
 * brak potwierdzenia to stan nieznany.
 */
import type { ApiDevice, ApiDeviceMetric, DeviceStatus } from '../api/devices'
import { KIND_LABEL } from './deviceLabels'

/** Grupy statusów na kaflach i w filtrze. */
export type StatusGroup = 'OK' | 'ATTENTION' | 'UNKNOWN' | 'DISABLED'

export const STATUS_GROUP_LABEL: Record<StatusGroup, string> = {
  OK: 'Działa',
  ATTENTION: 'Wymaga uwagi',
  UNKNOWN: 'Stan nieznany',
  DISABLED: 'Wyłączone',
}

export function statusGroup(status: DeviceStatus): StatusGroup {
  if (status === 'OK') return 'OK'
  if (status === 'STALE' || status === 'ERROR') return 'ATTENTION'
  return status
}

export interface DeviceFilter {
  query: string
  /** Typ urządzenia (`kind`) albo '' — wszystkie. */
  kind: string
  /** Grupa statusu albo '' — wszystkie. */
  group: StatusGroup | ''
}

export const NO_FILTER: DeviceFilter = { query: '', kind: '', group: '' }

const normalize = (text: string): string => text.trim().toLocaleLowerCase('pl-PL')

/** Szuka w nazwie, typie, producencie, modelu i adresie połączenia (adres tylko, gdy rola go widzi). */
export function matchesQuery(device: ApiDevice, query: string): boolean {
  const q = normalize(query)
  if (q === '') return true
  const haystack = [
    device.name,
    KIND_LABEL[device.kind] ?? device.kind,
    device.manufacturer,
    device.model,
    device.details?.connection.host ?? null,
  ]
  return haystack.some((text) => text !== null && normalize(text).includes(q))
}

export function filterDevices(devices: readonly ApiDevice[], filter: DeviceFilter): ApiDevice[] {
  return devices.filter(
    (d) =>
      (filter.kind === '' || d.kind === filter.kind) &&
      (filter.group === '' || statusGroup(d.status) === filter.group) &&
      matchesQuery(d, filter.query),
  )
}

export function statusCounts(devices: readonly ApiDevice[]): Record<StatusGroup, number> {
  const counts: Record<StatusGroup, number> = { OK: 0, ATTENTION: 0, UNKNOWN: 0, DISABLED: 0 }
  for (const d of devices) counts[statusGroup(d.status)] += 1
  return counts
}

/** Typy obecne w instalacji, w kolejności etykiet — do listy filtra. */
export function presentKinds(devices: readonly ApiDevice[]): string[] {
  const kinds = new Set(devices.map((d) => d.kind))
  const known = Object.keys(KIND_LABEL).filter((k) => kinds.has(k))
  const other = [...kinds].filter((k) => !(k in KIND_LABEL)).toSorted()
  return [...known, ...other]
}

const chartRank = (m: ApiDeviceMetric): number => (m.unit === 'W' ? (m.channel === null ? 0 : 1) : 2)

/**
 * Metryki do wykresu w panelu: chwilowe (bez liczników energii, których wykres liniowy nie ma
 * sensu bez różnicowania). Najpierw moce bez kanału — pierwsza jest domyślna.
 */
export function chartMetrics(device: Pick<ApiDevice, 'metrics'>): ApiDeviceMetric[] {
  return device.metrics.filter((m) => !m.cumulative).toSorted((a, b) => chartRank(a) - chartRank(b))
}

export const metricId = (m: Pick<ApiDeviceMetric, 'key' | 'channel'>): string => `${m.key}|${m.channel ?? ''}`
export const metricLabel = (m: Pick<ApiDeviceMetric, 'name' | 'channel'>): string =>
  m.channel === null ? m.name : `${m.name} ${m.channel}`

/** Zakresy małego wykresu: ostatnie 24 h, 7 i 30 dni (kroczące, od teraz). */
export type ChartSpan = '24h' | '7d' | '30d'

export const CHART_SPANS: ReadonlyArray<{ id: ChartSpan; label: string; hours: number }> = [
  { id: '24h', label: '24 h', hours: 24 },
  { id: '7d', label: '7 dni', hours: 24 * 7 },
  { id: '30d', label: '30 dni', hours: 24 * 30 },
]

export function spanRange(span: ChartSpan, now: Date): { from: Date; to: Date } {
  const hours = CHART_SPANS.find((s) => s.id === span)?.hours ?? 24
  return { from: new Date(now.getTime() - hours * 3_600_000), to: now }
}
