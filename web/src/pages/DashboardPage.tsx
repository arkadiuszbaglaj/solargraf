import { getSiteEnergy, type SiteEnergy } from '../api/energy'
import { useDataSource } from '../data/DataSourceContext'
import type { Site } from '../data/types'
import { useLiveSite } from '../hooks/useLiveSite'
import { usePeriodic } from '../hooks/usePeriodic'
import { startOfLocalDay } from '../lib/time'
import type { TodayState } from '../lib/today'
import { AlarmsWidget } from '../widgets/AlarmsWidget'
import { DeviceStatusWidget } from '../widgets/DeviceStatusWidget'
import { EnergyChartWidget } from '../widgets/EnergyChartWidget'
import { EnergyFlowPanel } from '../widgets/EnergyFlowPanel'
import { KpiRow } from '../widgets/KpiRow'
import { LiveKpiRow } from '../widgets/LiveKpiRow'
import { SiteAlarmsPanel } from '../widgets/SiteAlarmsPanel'
import { SiteDetailsPanels } from '../widgets/SiteDetailsPanels'
import { SiteDevicesPanel } from '../widgets/SiteDevicesPanel'
import { TodayPowerChart } from '../widgets/TodayPowerChart'
import styles from './DashboardPage.module.css'

async function loadToday(site: Site, now: Date, signal: AbortSignal): Promise<SiteEnergy> {
  const range = { from: startOfLocalDay(now, site.timezone), to: now }
  const result = await getSiteEnergy(site.id, range, (...args) => fetch(...args), signal)
  if (result.kind !== 'ok') throw new Error('Nie udało się pobrać energii.')
  return result.data
}

/**
 * Dashboard z API: wartości na żywo (D50), energia dziś (D51), urządzenia i agenci (D52),
 * przepływ energii (D54), alarmy (D55), szczegóły PV/baterii/sieci (D56). Jeden strumień SSE
 * dla kart, diagramu i szczegółów.
 */
function LiveDashboard({ site }: { site: Site }) {
  const live = useLiveSite(site.id)
  // Energia od północy w strefie instalacji; odświeżana co 5 min i po powrocie do karty.
  const { state } = usePeriodic(`${site.id}|${site.timezone}`, (now, signal) => loadToday(site, now, signal))
  const today: TodayState = state.status === 'ready' ? { status: 'ready', data: state.data } : state
  return (
    <div className={styles.page}>
      <LiveKpiRow live={live} today={today} />
      {/*
        Siatka 12 kolumn: przepływ | wykres dnia | urządzenia, niżej szczegóły | alarmy.
        Panele w jednym rzędzie mają równą wysokość — bez pustych pól między kolumnami.
      */}
      <div className={styles.layout}>
        <div className={`${styles.cell} ${styles.flowCell}`}>
          <EnergyFlowPanel live={live} />
        </div>
        <div className={`${styles.cell} ${styles.chartCell}`}>
          <TodayPowerChart siteId={site.id} timeZone={site.timezone} />
        </div>
        <div className={`${styles.cell} ${styles.devicesCell}`}>
          <SiteDevicesPanel siteId={site.id} />
        </div>
        <div className={styles.detailsCell}>
          <SiteDetailsPanels live={live} siteId={site.id} timeZone={site.timezone} today={today} />
        </div>
        <div className={`${styles.cell} ${styles.alarmsCell}`}>
          <SiteAlarmsPanel siteId={site.id} timeZone={site.timezone} />
        </div>
      </div>
    </div>
  )
}

export function DashboardPage({ site, now }: { site: Site; now: Date }) {
  const source = useDataSource()
  if (source.origin !== 'DEMO') {
    return <LiveDashboard site={site} />
  }
  return (
    <div className={styles.page}>
      <KpiRow siteId={site.id} now={now} />
      <div className={styles.grid}>
        <div className={styles.chart}>
          <EnergyChartWidget siteId={site.id} timeZone={site.timezone} />
        </div>
        <div className={styles.side}>
          <DeviceStatusWidget siteId={site.id} now={now} />
          <AlarmsWidget siteId={site.id} timeZone={site.timezone} />
        </div>
      </div>
    </div>
  )
}
