import { useState } from 'react'
import { acknowledgeAlarm, listAlarms, type AlarmList, type ApiAlarm } from '../api/alarms'
import { useOptionalSession } from '../auth/SessionContext'
import { Panel } from '../components/Panel'
import { WidgetState, type WidgetStatus } from '../components/WidgetState'
import { usePeriodic } from '../hooks/usePeriodic'
import { formatDateTime } from '../lib/format'
import { SEVERITY } from './alarmSeverity'
import styles from './List.module.css'
import own from './SiteAlarmsPanel.module.css'

export const ALARMS_REFRESH_MS = 30_000

const browserFetch: typeof fetch = (...args) => fetch(...args)

async function loadAlarms(siteId: string, fetchFn: typeof fetch, signal: AbortSignal): Promise<AlarmList> {
  const result = await listAlarms(siteId, fetchFn, signal)
  if (result.kind !== 'ok') throw new Error('Nie udało się pobrać alarmów.')
  return result.data
}

function AlarmItem({
  alarm,
  timeZone,
  canAcknowledge,
  busy,
  onAcknowledge,
}: {
  alarm: ApiAlarm
  timeZone: string
  canAcknowledge: boolean
  busy: boolean
  onAcknowledge: () => void
}) {
  const sev = SEVERITY[alarm.severity]
  const Icon = sev.icon
  const when = (iso: string) => <time dateTime={iso}>{formatDateTime(iso, timeZone)}</time>
  return (
    <li className={`${styles.item} ${alarm.closedAt ? own.closed : ''}`}>
      <Icon className={sev.className} size={20} aria-hidden="true" />
      <div className={styles.main}>
        <span className={styles.title}>{alarm.title}</span>
        <span className={styles.meta}>
          <span className={sev.className}>{sev.label}</span> · otwarty {when(alarm.openedAt)} ·{' '}
          {alarm.closedAt ? <>zamknięty {when(alarm.closedAt)}</> : 'aktywny'}
        </span>
        <span className={styles.meta}>
          {alarm.code === 'AGENT_UNREACHABLE' ? 'Ostatni heartbeat' : 'Ostatni udany odczyt'}:{' '}
          {alarm.lastOkAt ? when(alarm.lastOkAt) : 'nigdy'}
        </span>
        {alarm.details ? <span className={styles.meta}>{alarm.details}</span> : null}
        {alarm.acknowledgedAt ? (
          <span className={styles.meta}>
            Potwierdzony {when(alarm.acknowledgedAt)}
            {alarm.acknowledgedBy ? ` przez ${alarm.acknowledgedBy}` : ''}
          </span>
        ) : null}
      </div>
      {canAcknowledge && !alarm.acknowledgedAt ? (
        <button type="button" className={own.ack} onClick={onAcknowledge} disabled={busy}>
          {busy ? 'Potwierdzanie…' : 'Potwierdź'}
          <span className="visually-hidden">: {alarm.title}</span>
        </button>
      ) : null}
    </li>
  )
}

/**
 * Alarmy instalacji (D55): otwarte i zamknięte w ostatnich 24 h, czas w strefie instalacji.
 * Odświeżanie co 30 s i po powrocie do karty. Przycisk „Potwierdź” tylko, gdy serwer na to
 * pozwala (`canAcknowledge`) i UI działa za logowaniem (token CSRF z sesji).
 */
export function SiteAlarmsPanel({
  siteId,
  timeZone,
  fetchFn = browserFetch,
}: {
  siteId: string
  timeZone: string
  fetchFn?: typeof fetch
}) {
  const { state, reload } = usePeriodic(
    `alarms|${siteId}`,
    (_now, signal) => loadAlarms(siteId, fetchFn, signal),
    ALARMS_REFRESH_MS,
  )
  const session = useOptionalSession()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const acknowledge = async (alarm: ApiAlarm, csrfToken: string): Promise<void> => {
    setBusy(alarm.id)
    setError(null)
    const result = await acknowledgeAlarm(siteId, alarm.id, csrfToken, fetchFn)
    setBusy(null)
    if (result.ok) reload()
    else setError(result.message)
  }

  let status: WidgetStatus
  if (state.status === 'loading') status = { kind: 'loading' }
  else if (state.status === 'error') status = { kind: 'error', onRetry: reload }
  else if (state.data.alarms.length === 0) status = { kind: 'empty', message: 'Brak alarmów z ostatnich 24 h.' }
  else status = { kind: 'ready' }

  const ready = state.status === 'ready' ? state : null
  const csrfToken = session?.session.csrfToken ?? null
  const canAcknowledge = (ready?.data.canAcknowledge ?? false) && csrfToken !== null
  const active = ready?.data.alarms.filter((a) => a.closedAt === null).length ?? 0

  return (
    <Panel title="Alarmy" actions={ready ? <span className={own.count}>Aktywne: {active}</span> : null}>
      <WidgetState
        status={status}
        staleNotice={ready?.failed ? 'Nie udało się odświeżyć — alarmy z poprzedniego pobrania.' : null}
      >
        {error ? (
          <p role="alert" className={own.error}>
            {error}
          </p>
        ) : null}
        {ready ? (
          <ul className={styles.list}>
            {ready.data.alarms.map((alarm) => (
              <AlarmItem
                key={alarm.id}
                alarm={alarm}
                timeZone={timeZone}
                canAcknowledge={canAcknowledge}
                busy={busy === alarm.id}
                onAcknowledge={() => {
                  if (csrfToken) void acknowledge(alarm, csrfToken)
                }}
              />
            ))}
          </ul>
        ) : null}
      </WidgetState>
    </Panel>
  )
}
