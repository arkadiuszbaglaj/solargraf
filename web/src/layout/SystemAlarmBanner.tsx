import { bannerAlarms, getSystemAlarms, type SystemAlarms } from '../api/systemAlarms'
import { useOptionalSession } from '../auth/SessionContext'
import { usePeriodic } from '../hooks/usePeriodic'
import { formatDateTime } from '../lib/format'
import { browserTimeZone } from '../pages/ServerHealthPage'
import { SERVER_HEALTH_PATH } from '../paths'
import styles from './UpdateBanner.module.css'

/** Worker ocenia co 60 s (D60). */
export const SYSTEM_ALARM_BANNER_REFRESH_MS = 60_000

const browserFetch: typeof fetch = (...args) => fetch(...args)

/** Liczba z odmianą: 1 alarm, 2–4 alarmy, 5+ alarmów (12–14 — alarmów). */
export function alarmsWord(n: number): string {
  if (n === 1) return '1 alarm'
  const tens = n % 100
  const units = n % 10
  return units >= 2 && units <= 4 && (tens < 12 || tens > 14) ? `${n} alarmy` : `${n} alarmów`
}

/**
 * Baner alarmów serwera nad treścią każdej strony (P7.1d, D68) — tylko OWNER (inne role
 * dostałyby 403). Pokazuje otwarte niepotwierdzone alarmy, krytyczne także po potwierdzeniu,
 * oraz brak odpowiedzi workera. Błąd pobrania nie jest alarmem — baner się wtedy nie pojawia.
 */
export function SystemAlarmBanner({ fetchFn = browserFetch }: { fetchFn?: typeof fetch }) {
  const session = useOptionalSession()
  const isOwner = session?.session.memberships.some((m) => m.role === 'OWNER') ?? false
  if (session === null || !isOwner) return null
  return <OwnerSystemAlarmBanner fetchFn={fetchFn} />
}

function OwnerSystemAlarmBanner({ fetchFn }: { fetchFn: typeof fetch }) {
  const { state } = usePeriodic<SystemAlarms | null>(
    'system-alarm-banner',
    async (_now, signal) => {
      const result = await getSystemAlarms(fetchFn, signal)
      return result.kind === 'ok' ? result.data : null
    },
    SYSTEM_ALARM_BANNER_REFRESH_MS,
  )
  if (state.status !== 'ready' || state.data === null) return null
  const { workerStale, workerStaleSince } = state.data
  const shown = bannerAlarms(state.data.alarms)
  if (!workerStale && shown.length === 0) return null

  const critical = shown.filter((a) => a.severity === 'CRITICAL')
  const first = critical[0] ?? shown[0]
  const severe = workerStale || critical.length > 0
  const timeZone = browserTimeZone()
  return (
    <div className={`${styles.banner} ${severe ? styles.security : ''}`} role="status">
      <p>
        {workerStale ? (
          <strong>
            Usługa obliczeń serwera nie odpowiada
            {workerStaleSince ? ` od ${formatDateTime(workerStaleSince, timeZone)}` : ''} — alarmy i pomiary
            mogą być nieaktualne.
          </strong>
        ) : null}
        {workerStale && first ? ' ' : null}
        {first ? (
          <>
            <strong>
              Serwer: {alarmsWord(shown.length)}
              {critical.length > 0 ? ` (krytyczne: ${critical.length})` : ''}
            </strong>{' '}
            — {first.message}
            {shown.length > 1 ? ' i inne' : ''}.
          </>
        ) : null}{' '}
        <a href={SERVER_HEALTH_PATH}>Stan serwera</a>
      </p>
    </div>
  )
}
