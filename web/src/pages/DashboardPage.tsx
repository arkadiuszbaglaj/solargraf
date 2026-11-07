import { Panel } from '../components/Panel'
import { WidgetState } from '../components/WidgetState'
import { useDataSource } from '../data/DataSourceContext'
import type { Site } from '../data/types'
import { AlarmsWidget } from '../widgets/AlarmsWidget'
import { DeviceStatusWidget } from '../widgets/DeviceStatusWidget'
import { EnergyChartWidget } from '../widgets/EnergyChartWidget'
import { KpiRow } from '../widgets/KpiRow'
import { LiveKpiRow } from '../widgets/LiveKpiRow'
import styles from './DashboardPage.module.css'

const SOON = { kind: 'empty', message: 'Dostępne wkrótce.' } as const

/** Dashboard instalacji z API: bieżące wartości na żywo (D50), reszta w kolejnych wycinkach P5. */
function LiveDashboard({ site }: { site: Site }) {
  return (
    <div className={styles.page}>
      <LiveKpiRow siteId={site.id} />
      <div className={styles.grid}>
        <div className={styles.chart}>
          <Panel title="Produkcja i zużycie dziś">
            <WidgetState status={SOON} />
          </Panel>
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
