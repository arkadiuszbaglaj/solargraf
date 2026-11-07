import { AlertTriangle, Info, OctagonAlert, type LucideIcon } from 'lucide-react'
import { Panel } from '../components/Panel'
import { WidgetState, type WidgetStatus } from '../components/WidgetState'
import { useDataSource } from '../data/DataSourceContext'
import type { AlarmSeverity } from '../data/types'
import { useAsync } from '../hooks/useAsync'
import { formatDateTime } from '../lib/format'
import styles from './List.module.css'

const SEVERITY: Record<AlarmSeverity, { label: string; icon: LucideIcon; className: string }> = {
  CRITICAL: { label: 'Krytyczny', icon: OctagonAlert, className: styles.critical ?? '' },
  WARNING: { label: 'Ostrzeżenie', icon: AlertTriangle, className: styles.warning ?? '' },
  INFO: { label: 'Informacja', icon: Info, className: styles.info ?? '' },
}

export function AlarmsWidget({ siteId, timeZone }: { siteId: string; timeZone: string }) {
  const source = useDataSource()
  const { state, reload } = useAsync((signal) => source.getAlarms(siteId, signal), [source, siteId])

  let status: WidgetStatus
  if (state.status === 'loading') status = { kind: 'loading' }
  else if (state.status === 'error') status = { kind: 'error', onRetry: reload }
  else if (state.data.length === 0) status = { kind: 'empty', message: 'Brak alarmów.' }
  else status = { kind: 'ready' }

  return (
    <Panel title="Ostatnie alarmy">
      <WidgetState status={status}>
        {state.status === 'ready' ? (
          <ul className={styles.list}>
            {state.data.map((alarm) => {
              const sev = SEVERITY[alarm.severity]
              const Icon = sev.icon
              return (
                <li key={alarm.id} className={styles.item}>
                  <Icon className={sev.className} size={20} aria-hidden="true" />
                  <div className={styles.main}>
                    <span className={styles.title}>
                      <span className="visually-hidden">{sev.label}: </span>
                      {alarm.title}
                    </span>
                    <span className={styles.meta}>
                      <time dateTime={alarm.openedAt}>
                        {formatDateTime(alarm.openedAt, timeZone)}
                      </time>
                      {alarm.deviceName ? ` · ${alarm.deviceName}` : ''}
                      {alarm.acknowledged ? ' · potwierdzony' : ''}
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>
        ) : null}
      </WidgetState>
    </Panel>
  )
}
