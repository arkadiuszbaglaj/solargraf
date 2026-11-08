import { DemoBadge } from '../components/DemoBadge'
import { Panel } from '../components/Panel'
import { Ring } from '../components/Ring'
import { WidgetState } from '../components/WidgetState'
import { kpiView, todayEnergy, type TodayState } from '../lib/today'
import styles from './SiteDetailsPanels.module.css'

const ROWS = [
  { key: 'pv', label: 'Produkcja PV' },
  { key: 'load', label: 'Zużycie domu' },
  { key: 'grid_import', label: 'Pobrane z sieci' },
  { key: 'grid_export', label: 'Oddane do sieci' },
] as const

/**
 * Zużycie i samowystarczalność dziś (D69): pierścień samowystarczalności (KPI D27 z API energii,
 * D51) i energia od północy w strefie instalacji. Brak danych — „brak danych”, nigdy 0.
 */
export function EnergyBalancePanel({ today }: { today: TodayState }) {
  if (today.status !== 'ready') {
    return (
      <Panel title="Zużycie i samowystarczalność">
        <WidgetState status={today.status === 'loading' ? { kind: 'loading' } : { kind: 'error' }} />
      </Panel>
    )
  }
  const kpi = today.data.kpis.selfSufficiency
  const view = kpiView(kpi)
  const percent = kpi.status === 'OK' || kpi.status === 'INCOMPLETE' ? (kpi.value === null ? null : kpi.value * 100) : null
  return (
    <Panel
      title="Zużycie i samowystarczalność"
      actions={today.data.origins.includes('SIMULATED') ? <DemoBadge origin="SIMULATED" /> : null}
    >
      <div className={styles.batteryTop}>
        <Ring percent={percent}>
          <span className={styles.ringValue}>{view.value}</span>
          <span className={styles.ringLabel}>samowystar&shy;czalność</span>
        </Ring>
        <dl className={styles.list}>
          {ROWS.map((r) => (
            <div key={r.key} className={styles.row}>
              <dt className={styles.label}>{r.label}</dt>
              <dd className={styles.value}>
                <span className={styles.number}>{todayEnergy(today, r.key)}</span>
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <p className={styles.meta}>
        Dziś od północy. {kpi.definition}.
        {view.unavailableReason ? ` ${view.unavailableReason}.` : ''}
        {view.notice ? ` ${view.notice}.` : ''}
      </p>
    </Panel>
  )
}
