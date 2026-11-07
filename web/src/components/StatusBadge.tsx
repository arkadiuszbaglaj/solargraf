import type { DeviceStatus } from '../lib/freshness'
import styles from './StatusBadge.module.css'

const LABELS: Record<DeviceStatus, string> = {
  ONLINE: 'Online',
  NO_RESPONSE: 'Brak odpowiedzi',
  UNKNOWN: 'Stan nieznany',
}

/** Status z kolorem i tekstem — kolor nigdy nie jest jedynym nośnikiem informacji. */
export function StatusBadge({ status }: { status: DeviceStatus }) {
  return (
    <span className={`${styles.badge} ${styles[status]}`}>
      <span className={styles.dot} aria-hidden="true" />
      {LABELS[status]}
    </span>
  )
}
