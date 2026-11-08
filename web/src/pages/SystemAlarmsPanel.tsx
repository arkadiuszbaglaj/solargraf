import { useState } from 'react'
import { acknowledgeSystemAlarm, getSystemAlarms, type SystemAlarm, type SystemAlarms } from '../api/systemAlarms'
import { useOptionalSession } from '../auth/SessionContext'
import { Panel } from '../components/Panel'
import { WidgetState, type WidgetStatus } from '../components/WidgetState'
import { usePeriodic } from '../hooks/usePeriodic'
import { formatDateTime } from '../lib/format'
import { SEVERITY } from '../widgets/alarmSeverity'
import list from '../widgets/List.module.css'
import own from '../widgets/SiteAlarmsPanel.module.css'

/** Worker ocenia co 60 s (D60). */
export const SYSTEM_ALARMS_REFRESH_MS = 60_000

class SessionExpired extends Error {}

function AlarmItem({
  alarm,
  timeZone,
  canAcknowledge,
  busy,
  onAcknowledge,
}: {
  alarm: SystemAlarm
  timeZone: string
  canAcknowledge: boolean
  busy: boolean
  onAcknowledge: () => void
}) {
  const sev = SEVERITY[alarm.severity]
  const Icon = sev.icon
  const when = (iso: string) => <time dateTime={iso}>{formatDateTime(iso, timeZone)}</time>
  return (
    <li className={`${list.item} ${alarm.closedAt ? own.closed : ''}`}>
      <Icon className={sev.className} size={20} aria-hidden="true" />
      <div className={list.main}>
        <span className={list.title}>{alarm.message}</span>
        <span className={list.meta}>
          <span className={sev.className}>{sev.label}</span> · od {when(alarm.openedAt)} ·{' '}
          {alarm.closedAt ? <>ustąpił {when(alarm.closedAt)}</> : 'aktywny'}
        </span>
        {alarm.acknowledgedAt ? (
          <span className={list.meta}>
            Potwierdzony {when(alarm.acknowledgedAt)}
            {alarm.acknowledgedBy ? ` przez ${alarm.acknowledgedBy}` : ''}
          </span>
        ) : null}
      </div>
      {canAcknowledge && !alarm.acknowledgedAt ? (
        <button type="button" className={own.ack} onClick={onAcknowledge} disabled={busy}>
          {busy ? 'Potwierdzanie…' : 'Potwierdź'}
          <span className="visually-hidden">: {alarm.message}</span>
        </button>
      ) : null}
    </li>
  )
}

/**
 * Alarmy systemowe (P7.1d, D68) na stronie „Stan serwera”: otwarte i zamknięte z 7 dni,
 * potwierdzanie przez OWNER. Czas w strefie przeglądarki (serwer nie należy do instalacji).
 */
export function SystemAlarmsPanel({
  fetchFn,
  timeZone,
  onExpired,
}: {
  fetchFn: typeof fetch
  timeZone: string
  onExpired: () => void
}) {
  const { state, reload } = usePeriodic<SystemAlarms>(
    'system-alarms',
    async (_now, signal) => {
      const result = await getSystemAlarms(fetchFn, signal)
      if (result.kind === 'anonymous') {
        onExpired()
        throw new SessionExpired()
      }
      if (result.kind !== 'ok') throw new Error('alarms')
      return result.data
    },
    SYSTEM_ALARMS_REFRESH_MS,
  )
  const session = useOptionalSession()
  const csrfToken = session?.session.csrfToken ?? null
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const acknowledge = async (alarm: SystemAlarm, token: string): Promise<void> => {
    setBusy(alarm.id)
    setError(null)
    const result = await acknowledgeSystemAlarm(alarm.id, token, fetchFn)
    setBusy(null)
    if (result.ok) reload()
    else setError(result.message)
  }

  let status: WidgetStatus
  if (state.status === 'loading') status = { kind: 'loading' }
  else if (state.status === 'error') status = { kind: 'error', onRetry: reload }
  else if (state.data.alarms.length === 0) status = { kind: 'empty', message: 'Brak alarmów serwera z ostatnich 7 dni.' }
  else status = { kind: 'ready' }

  const ready = state.status === 'ready' ? state : null
  const active = ready?.data.alarms.filter((a) => a.closedAt === null).length ?? 0
  const staleNotice = ready?.data.workerStale
    ? 'Usługa obliczeń (worker) nie odpowiada — lista alarmów może być nieaktualna.'
    : ready?.failed
      ? 'Nie udało się odświeżyć — alarmy z poprzedniego pobrania.'
      : null

  return (
    <Panel title="Alarmy serwera" actions={ready ? <span className={own.count}>Aktywne: {active}</span> : null}>
      {ready?.data.workerStale && ready.data.alarms.length === 0 ? (
        <p role="status" className={own.error}>
          Usługa obliczeń (worker) nie odpowiada — alarmy serwera nie są aktualizowane.
        </p>
      ) : null}
      <WidgetState status={status} staleNotice={staleNotice}>
        {error ? (
          <p role="alert" className={own.error}>
            {error}
          </p>
        ) : null}
        {ready ? (
          <ul className={list.list}>
            {ready.data.alarms.map((alarm) => (
              <AlarmItem
                key={alarm.id}
                alarm={alarm}
                timeZone={timeZone}
                canAcknowledge={csrfToken !== null}
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
