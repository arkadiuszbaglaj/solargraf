import type { Origin } from '../data/types'
import styles from './DemoBadge.module.css'

/** Widoczne oznaczenie danych niepochodzących z urządzeń (CLAUDE.md: DEMO / SIMULATED). */
export function DemoBadge({ origin }: { origin: Origin }) {
  if (origin !== 'DEMO' && origin !== 'SIMULATED') {
    return null
  }
  const label = origin === 'DEMO' ? 'Dane demonstracyjne' : 'Dane symulowane'
  return (
    <span className={styles.badge} title={label} aria-label={label}>
      {origin}
    </span>
  )
}
