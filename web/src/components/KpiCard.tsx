import type { LucideIcon } from 'lucide-react'
import styles from './KpiCard.module.css'

/**
 * Karta KPI. Brak wartości pokazuje „—” z opisem; nieaktualna wartość jest wyszarzona i opisana.
 */
export function KpiCard({
  label,
  icon: Icon,
  value,
  detail,
  secondary,
  age,
  stale,
  unavailableReason,
  notice,
}: {
  label: string
  icon: LucideIcon
  value: string
  detail?: string | null
  secondary?: string | null
  /** Dodatkowa wartość w stopce karty, np. „Moc: 1,50 kW” magazynu. */
  age?: string | null
  stale: boolean
  unavailableReason?: string | null
  /** Ostrzeżenie o jakości wyniku (niedostępny, niepełne dane) — kolor ostrzeżenia. */
  notice?: string | null
}) {
  return (
    <article className={`${styles.card} ${stale ? styles.stale : ''}`}>
      <header className={styles.header}>
        <span className={styles.iconWrap} aria-hidden="true">
          <Icon className={styles.icon} size={18} />
        </span>
        <h3 className={styles.label}>{label}</h3>
      </header>
      <p className={styles.value}>{value}</p>
      {unavailableReason ? <p className={styles.detail}>{unavailableReason}</p> : null}
      {notice ? <p className={styles.notice}>{notice}</p> : null}
      {detail ? <p className={styles.detail}>{detail}</p> : null}
      {secondary ? <p className={styles.secondary}>{secondary}</p> : null}
      {age || stale ? (
        <footer className={styles.footer}>
          {age ? <p className={styles.age}>{age}</p> : null}
          {stale ? <p className={styles.staleText}>Wartość nieaktualna</p> : null}
        </footer>
      ) : null}
    </article>
  )
}
