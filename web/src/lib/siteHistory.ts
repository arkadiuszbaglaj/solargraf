/**
 * Historia instalacji (D66): serie mocy i SoC dla zakresu, każda z dokładnie jednego
 * włączonego urządzenia-źródła (jak D51), z API historii urządzenia (D46) przy rozdzielczości
 * `auto`. Bez sumowania po urządzeniach; brak albo kilka źródeł → seria niedostępna.
 * Przedziały bez danych zostają `null` — wykres pokazuje przerwę, nigdy 0.
 */
import type { ApiDevice } from '../api/devices'
import { listDevices } from '../api/devices'
import { getHistory, type History, type HistoryResolution } from '../api/history'
import { singleSource } from './liveValues'

export class SessionExpiredError extends Error {}

export type SeriesColor = 'pv' | 'home' | 'grid' | 'battery'

export interface SeriesDef {
  metric: string
  name: string
  color: SeriesColor
}

/** Serie wykresu mocy (kW); znaki wg D39. */
export const POWER_SERIES: readonly SeriesDef[] = [
  { metric: 'pv_power', name: 'Produkcja PV', color: 'pv' },
  { metric: 'load_power', name: 'Zużycie domu', color: 'home' },
  { metric: 'grid_power', name: 'Sieć (+ pobór, − oddawanie)', color: 'grid' },
  { metric: 'battery_power', name: 'Bateria (+ rozładowanie, − ładowanie)', color: 'battery' },
]

export const SOC_SERIES: SeriesDef = { metric: 'battery_soc', name: 'Stan naładowania baterii', color: 'battery' }

export interface LoadedSeries extends SeriesDef {
  history: History
}

export interface SiteHistory {
  power: LoadedSeries[]
  soc: LoadedSeries | null
  /** Opisy serii bez jednego źródła, np. „Bateria — brak źródła”. */
  missing: string[]
  /** Suma pochodzeń surowych pomiarów wszystkich serii (np. SIMULATED). */
  origins: string[]
  /** Rozdzielczość wybrana przez serwer (ta sama dla zakresu); null, gdy brak serii. */
  resolution: HistoryResolution | null
}

export const seriesHasValues = (s: LoadedSeries): boolean => s.history.points.some((p) => p.value !== null)

export async function loadSiteHistory(
  siteId: string,
  range: { from: Date; to: Date },
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<SiteHistory> {
  const devices = await listDevices(siteId, fetchFn, signal)
  if (devices.kind === 'anonymous') throw new SessionExpiredError()
  if (devices.kind !== 'ok') throw new Error('devices')
  const missing: string[] = []

  const load = async (def: SeriesDef, list: readonly ApiDevice[]): Promise<LoadedSeries | null> => {
    const source = singleSource(list, def.metric)
    if (source.kind !== 'one') {
      missing.push(`${def.name} — ${source.kind === 'many' ? 'wiele źródeł' : 'brak źródła'}`)
      return null
    }
    const result = await getHistory(
      siteId,
      source.device.id,
      { metric: def.metric, channel: null, from: range.from, to: range.to },
      fetchFn,
      signal,
    )
    if (result.kind === 'anonymous') throw new SessionExpiredError()
    if (result.kind !== 'ok') throw new Error('history')
    return { ...def, history: result.data }
  }

  const loaded = await Promise.all([...POWER_SERIES, SOC_SERIES].map((def) => load(def, devices.data)))
  const power = loaded.slice(0, POWER_SERIES.length).filter((s): s is LoadedSeries => s !== null)
  const soc = loaded[POWER_SERIES.length] ?? null
  const all = soc ? [...power, soc] : power
  return {
    power,
    soc,
    // Kolejność jak serii: `missing.push` wykonuje się synchronicznie, przed pierwszym `await`.
    missing,
    origins: [...new Set(all.flatMap((s) => s.history.origins))].toSorted(),
    resolution: all[0]?.history.resolution ?? null,
  }
}
