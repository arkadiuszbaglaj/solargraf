import { getSiteEnergy, type SiteEnergy } from '../api/energy'
import { Panel } from '../components/Panel'
import { WidgetState } from '../components/WidgetState'
import { useDataSource } from '../data/DataSourceContext'
import type { Site } from '../data/types'
import { usePeriodic } from '../hooks/usePeriodic'
import { startOfLocalDay } from '../lib/time'
import type { TodayState } from '../lib/today'
import { AlarmsWidget } from '../widgets/AlarmsWidget'
import { DeviceStatusWidget } from '../widgets/DeviceStatusWidget'
import { EnergyChartWidget } from '../widgets/EnergyChartWidget'
import { KpiRow } from '../widgets/KpiRow'
import { LiveKpiRow } from '../widgets/LiveKpiRow'
import { TodayPowerChart } from '../widgets/TodayPowerChart'
import styles from './DashboardPage.module.css'

const SOON = { kind: 'empty', message: 'Dostępne wkrótce.' } as const

async function loadToday(site: Site, now: Date, signal: AbortSignal): Promise<SiteEnergy> {
  const range = { from: startOfLocalDay(now, site.timezone), to: now }
  const result = await getSiteEnergy(site.id, range, (...args) => fetch(...args), signal)
  if (result.kind !== 'ok') throw new Error('Nie udało się pobrać energii.')
  return result.data
}

/** Dashboard instalacji z API: wartości na żywo (D50), energia i moc dziś (D51), reszta później. */
function LiveDashboard({ site }: { site: Site }) {
  // Energia od północy w strefie instalacji; odświeżana co 5 min i po powrocie do karty.
  const { state } = usePeriodic(`${site.id}|${site.timezone}`, (now, signal) => loadToday(site, now, signal))
  const today: TodayState = state.status === 'ready' ? { status: 'ready', data: state.data } : state
  return (
    <div className={styles.page}>
      <LiveKpiRow siteId={site.id} today={today} />
      <div className={styles.grid}>
        <div className={styles.chart}>
          <TodayPowerChart siteId={site.id} timeZone={site.timezone} />
        </div>
        <div className={styles.side}>
          <Panel
            title="Urządzenia"
            actions={<a href={`/instalacje/${encodeURIComponent(site.id)}/urzadzenia`}>Lista urządzeń</a>}
          >
            <WidgetState status={SOON} />
          </Panel>
          <Panel title="Alarmy">
            <WidgetState status={SOON} />
          </Panel>
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
