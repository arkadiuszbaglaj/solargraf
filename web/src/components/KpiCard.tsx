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
  /** Wiek wartości chwilowej, np. „Odczyt 12 s temu”. */
  age?: string | null
  stale: boolean
  unavailableReason?: string | null
  /** Ostrzeżenie o jakości wyniku (niedostępny, niepełne dane) — kolor ostrzeżenia. */
  notice?: string | null
}) {
  return (
    <article className={`${styles.card} ${stale ? styles.stale : ''}`}>
      <Icon className={styles.icon} aria-hidden="true" size={22} />
      <div className={styles.body}>
        <h3 className={styles.label}>{label}</h3>
        <p className={styles.value}>{value}</p>
        {unavailableReason ? <p className={styles.detail}>{unavailableReason}</p> : null}
        {notice ? <p className={styles.notice}>{notice}</p> : null}
        {detail ? <p className={styles.detail}>{detail}</p> : null}
        {secondary ? <p className={styles.secondary}>{secondary}</p> : null}
        {age ? <p className={styles.secondary}>{age}</p> : null}
        {stale ? <p className={styles.staleText}>Wartość nieaktualna</p> : null}
      </div>
    </article>
  )
}
