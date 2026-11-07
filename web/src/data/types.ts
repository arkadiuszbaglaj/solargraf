/**
 * Kontrakt danych dashboardu po stronie UI.
 * Do czasu API (P2) jedyną implementacją jest źródło DEMO. Typy odpowiadają docs/DATA_MODEL.md:
 * jednostki kanoniczne (W, Wh, V, A, °C, %), czasy w UTC (ISO 8601), brak wartości = null.
 */

export type Unit = 'W' | 'Wh' | '%' | 'V' | 'A' | '°C' | 'Hz'
export type Quality = 'GOOD' | 'ESTIMATED' | 'STALE' | 'INVALID' | 'MISSING'
export type Origin = 'DEVICE' | 'DERIVED' | 'SIMULATED' | 'DEMO'

export interface Measurement {
  /** Wartość w jednostce kanonicznej; null = brak pomiaru (nigdy zastępcze 0). */
  value: number | null
  unit: Unit
  /** Czas obserwacji, UTC ISO 8601; null, gdy nieznany. */
  observedAt: string | null
  quality: Quality
  origin: Origin
}

export interface Site {
  id: string
  name: string
  /** Strefa IANA instalacji, w której UI prezentuje czas (D13). */
  timezone: string
}

export interface DashboardKpis {
  origin: Origin
  /** Po tylu sekundach od observedAt wartość chwilowa jest nieaktualna. */
  staleAfterSeconds: number
  pvPower: Measurement
  homePower: Measurement
  /** Konwencja znaku: dodatnia = pobór z sieci (import), ujemna = oddawanie (eksport). */
  gridPower: Measurement
  /** Konwencja znaku D39: dodatnia = rozładowanie, ujemna = ładowanie. */
  batteryPower: Measurement
  batterySoc: Measurement
  todayPvEnergy: Measurement
  todayHomeEnergy: Measurement
  todayGridImportEnergy: Measurement
  todayGridExportEnergy: Measurement
  /** Autokonsumpcja dziś (D27), w %. */
  todaySelfConsumption: Measurement
}

/** Punkt serii: [czas UTC ISO, wartość w W lub null dla luki]. */
export type SeriesPoint = readonly [string, number | null]

export interface EnergyChart {
  origin: Origin
  /** Data lokalna instalacji, YYYY-MM-DD. */
  localDate: string
  unit: 'W'
  pv: SeriesPoint[]
  home: SeriesPoint[]
  /** Pobór z sieci (import, ≥ 0) albo moc sieci ze znakiem D39 — wg `gridLabel`. */
  gridImport: SeriesPoint[]
  /** Nazwa serii sieci w legendzie; domyślnie „Pobór z sieci”. */
  gridLabel?: string
}

export type DeviceKind = 'INVERTER' | 'BATTERY' | 'BMS' | 'METER' | 'MPPT' | 'SENSOR'

export interface DeviceHealth {
  id: string
  name: string
  kind: DeviceKind
  /** Model, jeśli znany; null = nieznany (nie zgadujemy). */
  model: string | null
  origin: Origin
  lastSuccessAt: string | null
  freshnessThresholdSeconds: number
  /** Czy agent obsługujący urządzenie jest osiągalny (świeży heartbeat). */
  agentReachable: boolean
}

export type AlarmSeverity = 'CRITICAL' | 'WARNING' | 'INFO'

export interface AlarmSummary {
  id: string
  severity: AlarmSeverity
  title: string
  deviceName: string | null
  openedAt: string
  acknowledged: boolean
  origin: Origin
}

export interface DashboardDataSource {
  /** Pochodzenie danych źródła — UI pokazuje oznaczenie DEMO/SIMULATED. */
  readonly origin: Origin
  listSites(signal?: AbortSignal): Promise<Site[]>
  getKpis(siteId: string, signal?: AbortSignal): Promise<DashboardKpis>
  getEnergyChart(siteId: string, signal?: AbortSignal): Promise<EnergyChart>
  getDevices(siteId: string, signal?: AbortSignal): Promise<DeviceHealth[]>
  getAlarms(siteId: string, signal?: AbortSignal): Promise<AlarmSummary[]>
}
