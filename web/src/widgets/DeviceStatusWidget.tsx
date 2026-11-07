import { Panel } from '../components/Panel'
import { StatusBadge } from '../components/StatusBadge'
import { WidgetState, type WidgetStatus } from '../components/WidgetState'
import { useDataSource } from '../data/DataSourceContext'
import type { DeviceKind } from '../data/types'
import { useAsync } from '../hooks/useAsync'
import { formatAge } from '../lib/format'
import { ageSeconds, deviceStatus } from '../lib/freshness'
import styles from './List.module.css'

const KIND_LABELS: Record<DeviceKind, string> = {
  INVERTER: 'Falownik',
  BATTERY: 'Magazyn energii',
  BMS: 'BMS',
  METER: 'Licznik',
  MPPT: 'Tracker MPPT',
  SENSOR: 'Czujnik',
}

export function DeviceStatusWidget({ siteId, now }: { siteId: string; now: Date }) {
  const source = useDataSource()
  const { state, reload } = useAsync((signal) => source.getDevices(siteId, signal), [source, siteId])

  let status: WidgetStatus
  if (state.status === 'loading') status = { kind: 'loading' }
  else if (state.status === 'error') status = { kind: 'error', onRetry: reload }
  else if (state.data.length === 0)
    status = { kind: 'empty', message: 'Brak skonfigurowanych urządzeń.' }
  else status = { kind: 'ready' }

  return (
    <Panel title="Status urządzeń">
      <WidgetState status={status}>
        {state.status === 'ready' ? (
          <ul className={styles.list}>
            {state.data.map((device) => {
              const age = ageSeconds(device.lastSuccessAt, now)
              return (
                <li key={device.id} className={styles.item}>
                  <div className={styles.main}>
                    <span className={styles.title}>{device.name}</span>
                    <span className={styles.meta}>
                      {KIND_LABELS[device.kind]} · {device.model ?? 'model nieznany'}
                    </span>
                    <span className={styles.meta}>
                      Ostatni odczyt: {age === null ? 'brak' : `${formatAge(age)} temu`}
                    </span>
                  </div>
                  <StatusBadge status={deviceStatus(device, now)} />
                </li>
              )
            })}
          </ul>
        ) : null}
      </WidgetState>
    </Panel>
  )
}
