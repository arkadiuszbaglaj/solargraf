import type { SupportLevel } from '../api/devices'
import { SUPPORT_LEVEL } from '../lib/deviceLabels'
import styles from './SupportLevelLabel.module.css'

/**
 * Poziom wsparcia profilu urządzenia (D58). Tekst zawsze widoczny; opis ryzyka w podpowiedzi
 * i dla czytników ekranu. Poziom inny niż VERIFIED jest wyróżniony kolorem ostrzeżenia.
 */
export function SupportLevelLabel({ level }: { level: SupportLevel | null }) {
  if (level === null) return <span className={styles.unknown}>Poziom wsparcia nieznany</span>
  const { label, description } = SUPPORT_LEVEL[level]
  return (
    <span className={level === 'VERIFIED' ? styles.verified : styles.unverified} title={description}>
      {label}
      <span className="visually-hidden">. {description}</span>
    </span>
  )
}
