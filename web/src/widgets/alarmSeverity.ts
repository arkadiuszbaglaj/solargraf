/** Priorytet alarmu: etykieta, ikona i kolor (zawsze z tekstem) — DEMO i API (D55). */
import { AlertTriangle, Info, OctagonAlert, type LucideIcon } from 'lucide-react'
import type { AlarmSeverity } from '../data/types'
import styles from './List.module.css'

export const SEVERITY: Record<AlarmSeverity, { label: string; icon: LucideIcon; className: string }> = {
  CRITICAL: { label: 'Krytyczny', icon: OctagonAlert, className: styles.critical ?? '' },
  WARNING: { label: 'Ostrzeżenie', icon: AlertTriangle, className: styles.warning ?? '' },
  INFO: { label: 'Informacja', icon: Info, className: styles.info ?? '' },
}
