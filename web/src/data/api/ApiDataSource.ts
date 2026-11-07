import { listSites } from '../../api/sites'
import type { DashboardDataSource, Site } from '../types'

const LIVE_ONLY = 'Dashboard z API korzysta ze strumienia na żywo (D50).'

/**
 * Źródło produkcyjne: instalacje z `/api/sites`. Bieżące wartości przychodzą strumieniem SSE
 * (`LiveKpiRow`); wykres, status urządzeń i alarmy dashboardu dojdą w kolejnych wycinkach P5.
 */
export class ApiDataSource implements DashboardDataSource {
  readonly origin = 'DEVICE' as const

  private readonly fetchFn: typeof fetch

  constructor(fetchFn: typeof fetch = (...args) => fetch(...args)) {
    this.fetchFn = fetchFn
  }

  async listSites(signal?: AbortSignal): Promise<Site[]> {
    const result = await listSites(this.fetchFn, signal)
    if (result.kind !== 'ok') throw new Error('Nie udało się pobrać instalacji.')
    return result.sites.map(({ id, name, timezone }) => ({ id, name, timezone }))
  }

  getKpis(): Promise<never> {
    return Promise.reject(new Error(LIVE_ONLY))
  }

  getEnergyChart(): Promise<never> {
    return Promise.reject(new Error(LIVE_ONLY))
  }

  getDevices(): Promise<never> {
    return Promise.reject(new Error(LIVE_ONLY))
  }

  getAlarms(): Promise<never> {
    return Promise.reject(new Error(LIVE_ONLY))
  }
}
