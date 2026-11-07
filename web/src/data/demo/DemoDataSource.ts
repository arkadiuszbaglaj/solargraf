/**
 * Źródło danych DEMO — wyłącznie do prezentacji UI przed podłączeniem API (P2/P5).
 *
 * Wartości są generowane deterministycznie z prostego modelu (krzywa PV, profil zużycia,
 * bateria) i NIE pochodzą z żadnego urządzenia ani z makiet. Każda wartość ma origin = 'DEMO'.
 * Celowo zawierają: lukę w danych (13:00–13:45), urządzenie bez odpowiedzi oraz instalację
 * z nieosiągalnym agentem, żeby UI pokazywało stany „brak danych”, „nieaktualne” i UNKNOWN.
 */
import type {
  AlarmSummary,
  DashboardDataSource,
  DashboardKpis,
  DeviceHealth,
  EnergyChart,
  Measurement,
  SeriesPoint,
  Site,
  Unit,
} from '../types'
import { localDate, startOfLocalDay } from '../../lib/time'

const STEP_MS = 5 * 60 * 1000
const STALE_AFTER_S = 60
const TZ = 'Europe/Warsaw'

interface SiteModel {
  site: Site
  pvPeakW: number
  sunriseH: number
  sunsetH: number
  batteryCapacityWh: number
  /** Agent przestał odpowiadać tyle minut temu (null = działa). */
  agentLostMinutesAgo: number | null
}

const SITES: SiteModel[] = [
  {
    site: { id: 'demo-a', name: 'Instalacja demonstracyjna A', timezone: TZ },
    pvPeakW: 5200,
    sunriseH: 7,
    sunsetH: 16.5,
    batteryCapacityWh: 10000,
    agentLostMinutesAgo: null,
  },
  {
    site: { id: 'demo-b', name: 'Instalacja demonstracyjna B (agent offline)', timezone: TZ },
    pvPeakW: 3800,
    sunriseH: 7,
    sunsetH: 16.5,
    batteryCapacityWh: 5000,
    agentLostMinutesAgo: 25,
  },
]

/** Deterministyczny „szum” w zakresie [0, 1). */
function noise(i: number): number {
  const x = Math.sin(i * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

function pvW(model: SiteModel, hour: number, i: number): number {
  if (hour <= model.sunriseH || hour >= model.sunsetH) {
    return 0
  }
  const x = (hour - model.sunriseH) / (model.sunsetH - model.sunriseH)
  const clouds = 0.82 + 0.18 * noise(i)
  return Math.round(model.pvPeakW * Math.sin(Math.PI * x) ** 1.5 * clouds)
}

function homeW(hour: number, i: number): number {
  let w = 350
  if (hour >= 6.5 && hour < 8) w += 1300
  if (hour >= 12 && hour < 13) w += 800
  if (hour >= 17 && hour < 21.5) w += 1500
  return Math.round(w * (0.85 + 0.3 * noise(i + 1000)))
}

function inGap(hour: number): boolean {
  return hour >= 13 && hour < 13.75
}

function localHour(t: number, dayStart: number): number {
  return (t - dayStart) / 3_600_000
}

interface Step {
  t: number
  pv: number | null
  home: number | null
  battery: number | null
  grid: number | null
}

interface Simulation {
  steps: Step[]
  socPercent: number
  energy: { pv: number; home: number; gridImport: number; gridExport: number }
  lastDataAt: number
}

function simulate(model: SiteModel, now: Date): Simulation {
  const dayStart = startOfLocalDay(now, model.site.timezone).getTime()
  const lastDataAt =
    model.agentLostMinutesAgo === null ? now.getTime() : now.getTime() - model.agentLostMinutesAgo * 60_000
  let socWh = model.batteryCapacityWh * 0.45
  const minWh = model.batteryCapacityWh * 0.1
  const energy = { pv: 0, home: 0, gridImport: 0, gridExport: 0 }
  const steps: Step[] = []
  const hoursPerStep = STEP_MS / 3_600_000

  for (let t = dayStart, i = 0; t <= lastDataAt; t += STEP_MS, i += 1) {
    const hour = localHour(t, dayStart)
    if (inGap(hour)) {
      steps.push({ t, pv: null, home: null, battery: null, grid: null })
      continue
    }
    const pv = pvW(model, hour, i)
    const home = homeW(hour, i)
    const surplus = pv - home
    let battery: number
    if (surplus > 0) {
      const room = (model.batteryCapacityWh - socWh) / hoursPerStep
      battery = Math.min(surplus, 2500, Math.max(0, room))
    } else {
      const available = (socWh - minWh) / hoursPerStep
      battery = -Math.min(-surplus, 2500, Math.max(0, available))
    }
    battery = Math.round(battery)
    const grid = home - pv + battery
    socWh += battery * hoursPerStep
    energy.pv += pv * hoursPerStep
    energy.home += home * hoursPerStep
    energy.gridImport += Math.max(grid, 0) * hoursPerStep
    energy.gridExport += Math.max(-grid, 0) * hoursPerStep
    steps.push({ t, pv, home, battery, grid })
  }
  return { steps, socPercent: (socWh / model.batteryCapacityWh) * 100, energy, lastDataAt }
}

function iso(t: number): string {
  return new Date(t).toISOString()
}

function point(t: number, v: number | null): SeriesPoint {
  return [iso(t), v]
}

function demo(value: number | null, unit: Unit, observedAt: number): Measurement {
  return {
    value,
    unit,
    observedAt: new Date(observedAt).toISOString(),
    quality: value === null ? 'MISSING' : 'GOOD',
    origin: 'DEMO',
  }
}

export interface DemoDataSourceOptions {
  /** Zegar — w testach stały. */
  now?: () => Date
  /** Sztuczne opóźnienie odpowiedzi [ms], żeby było widać stan ładowania. */
  latencyMs?: number
}

export class DemoDataSource implements DashboardDataSource {
  readonly origin = 'DEMO' as const
  private readonly now: () => Date
  private readonly latencyMs: number

  constructor(options: DemoDataSourceOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.latencyMs = options.latencyMs ?? 300
  }

  private delay<T>(make: () => T, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('Przerwano', 'AbortError'))
        return
      }
      const timer = setTimeout(() => {
        try {
          resolve(make())
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      }, this.latencyMs)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new DOMException('Przerwano', 'AbortError'))
      })
    })
  }

  private model(siteId: string): SiteModel {
    const model = SITES.find((m) => m.site.id === siteId)
    if (!model) {
      throw new Error('Nieznana instalacja')
    }
    return model
  }

  listSites(signal?: AbortSignal): Promise<Site[]> {
    return this.delay(() => SITES.map((m) => m.site), signal)
  }

  getKpis(siteId: string, signal?: AbortSignal): Promise<DashboardKpis> {
    return this.delay(() => {
      const model = this.model(siteId)
      const sim = simulate(model, this.now())
      const last = sim.steps.at(-1)
      // Ostatni odczyt: kilka sekund przed „teraz” albo w chwili utraty agenta.
      const at = sim.lastDataAt - 8000
      const { pv, home, gridImport, gridExport } = sim.energy
      const selfConsumption = pv > 0 ? ((pv - gridExport) / pv) * 100 : null
      return {
        origin: 'DEMO',
        staleAfterSeconds: STALE_AFTER_S,
        pvPower: demo(last?.pv ?? null, 'W', at),
        homePower: demo(last?.home ?? null, 'W', at),
        gridPower: demo(last?.grid ?? null, 'W', at),
        // Model liczy + ładowanie; kontrakt UI (D39): + rozładowanie, − ładowanie.
        batteryPower: demo(last === undefined || last.battery === null ? null : 0 - last.battery, 'W', at),
        batterySoc: demo(
          last === undefined || last.battery === null ? null : Math.round(sim.socPercent),
          '%',
          at,
        ),
        todayPvEnergy: demo(Math.round(pv), 'Wh', at),
        todayHomeEnergy: demo(Math.round(home), 'Wh', at),
        todayGridImportEnergy: demo(Math.round(gridImport), 'Wh', at),
        todayGridExportEnergy: demo(Math.round(gridExport), 'Wh', at),
        todaySelfConsumption: demo(selfConsumption, '%', at),
      }
    }, signal)
  }

  getEnergyChart(siteId: string, signal?: AbortSignal): Promise<EnergyChart> {
    return this.delay(() => {
      const model = this.model(siteId)
      const now = this.now()
      const sim = simulate(model, now)
      return {
        origin: 'DEMO',
        localDate: localDate(now, model.site.timezone),
        unit: 'W',
        pv: sim.steps.map((s) => point(s.t, s.pv)),
        home: sim.steps.map((s) => point(s.t, s.home)),
        gridImport: sim.steps.map((s) => point(s.t, s.grid === null ? null : Math.max(s.grid, 0))),
      }
    }, signal)
  }

  getDevices(siteId: string, signal?: AbortSignal): Promise<DeviceHealth[]> {
    return this.delay(() => {
      const model = this.model(siteId)
      const now = this.now().getTime()
      const reachable = model.agentLostMinutesAgo === null
      const lastOk = reachable ? now - 10_000 : now - (model.agentLostMinutesAgo ?? 0) * 60_000
      const base = { model: null, origin: 'DEMO' as const, agentReachable: reachable, freshnessThresholdSeconds: 60 }
      return [
        { ...base, id: `${siteId}-inv`, name: 'Falownik', kind: 'INVERTER', lastSuccessAt: iso(lastOk) },
        { ...base, id: `${siteId}-bat`, name: 'Magazyn energii', kind: 'BATTERY', lastSuccessAt: iso(lastOk) },
        {
          ...base,
          id: `${siteId}-meter`,
          name: 'Licznik sieci',
          kind: 'METER',
          // Na instalacji A licznik nie odpowiada od 10 min (demonstracja NO_RESPONSE).
          lastSuccessAt: iso(reachable ? now - 10 * 60_000 : lastOk),
        },
        { ...base, id: `${siteId}-mppt1`, name: 'MPPT 1', kind: 'MPPT', lastSuccessAt: iso(lastOk) },
      ]
    }, signal)
  }

  getAlarms(siteId: string, signal?: AbortSignal): Promise<AlarmSummary[]> {
    return this.delay(() => {
      const model = this.model(siteId)
      const now = this.now()
      if (model.agentLostMinutesAgo !== null) {
        return [
          {
            id: `${siteId}-agent`,
            severity: 'CRITICAL',
            title: 'Brak połączenia z agentem',
            deviceName: null,
            openedAt: iso(now.getTime() - model.agentLostMinutesAgo * 60_000),
            acknowledged: false,
            origin: 'DEMO',
          },
        ]
      }
      const alarms: AlarmSummary[] = [
        {
          id: `${siteId}-meter`,
          severity: 'WARNING',
          title: 'Brak odpowiedzi urządzenia',
          deviceName: 'Licznik sieci',
          openedAt: iso(now.getTime() - 10 * 60_000),
          acknowledged: false,
          origin: 'DEMO',
        },
      ]
      const gapStart = startOfLocalDay(now, model.site.timezone).getTime() + 13 * 3_600_000
      if (now.getTime() >= gapStart) {
        alarms.push({
          id: `${siteId}-gap`,
          severity: 'INFO',
          title: 'Luka w danych pomiarowych (45 min)',
          deviceName: null,
          openedAt: iso(gapStart),
          acknowledged: true,
          origin: 'DEMO',
        })
      }
      return alarms
    }, signal)
  }
}
