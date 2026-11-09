import { useEffect } from 'react'
import { ALARMS_CHANGED_EVENT, listAlarmPage, type AlarmSummary } from '../api/alarms'
import { usePeriodic } from '../hooks/usePeriodic'
import { ALARMS_REFRESH_MS } from '../widgets/SiteAlarmsPanel'
import styles from './Sidebar.module.css'

const browserFetch: typeof fetch = (...args) => fetch(...args)

export type AlarmBadge =
  | { kind: 'active'; count: number; critical: boolean }
  | { kind: 'pending'; count: number }
  | { kind: 'none' }

/**
 * Znacznik przy „Alarmy” w menu: liczba aktywnych (kolor wg najwyższego priorytetu), a gdy
 * aktywnych brak — kropka dla zamkniętych czekających na potwierdzenie.
 */
export function alarmBadge(summary: AlarmSummary): AlarmBadge {
  const active = summary.criticalActive + summary.warningActive
  if (active > 0) return { kind: 'active', count: active, critical: summary.criticalActive > 0 }
  if (summary.unacknowledged > 0) return { kind: 'pending', count: summary.unacknowledged }
  return { kind: 'none' }
}

/** Alarmy instalacji wybranej w pasku górnym (24 h, jak dashboard); błąd pobrania — bez znacznika. */
export function AlarmNavBadge({ siteId, fetchFn = browserFetch }: { siteId: string; fetchFn?: typeof fetch }) {
  const { state, reload } = usePeriodic<AlarmSummary | null>(
    `nav-alarms|${siteId}`,
    async (_now, signal) => {
      const query = { days: 1, state: 'all', severity: 'all', offset: 0, limit: 1 } as const
      const result = await listAlarmPage(siteId, query, fetchFn, signal)
      return result.kind === 'ok' ? result.data.summary : null
    },
    ALARMS_REFRESH_MS,
  )
  useEffect(() => {
    window.addEventListener(ALARMS_CHANGED_EVENT, reload)
    return () => window.removeEventListener(ALARMS_CHANGED_EVENT, reload)
  }, [reload])

  if (state.status !== 'ready' || state.data === null) return null
  const badge = alarmBadge(state.data)
  if (badge.kind === 'active') {
    return (
      <span className={`${styles.badge} ${badge.critical ? styles.badgeCritical : styles.badgeWarning}`}>
        <span aria-hidden="true">{badge.count}</span>
        <span className="visually-hidden">
          {` (aktywne: ${badge.count}${badge.critical ? ', w tym krytyczne' : ''})`}
        </span>
      </span>
    )
  }
  if (badge.kind === 'pending') {
    return (
      <span className={styles.dot} title={`Do potwierdzenia: ${badge.count}`}>
        <span className="visually-hidden">{` (do potwierdzenia: ${badge.count})`}</span>
      </span>
    )
  }
  return null
}
