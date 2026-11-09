import { AlertTriangle, BellRing, CheckCheck, OctagonAlert } from 'lucide-react'
import { useState } from 'react'
import { ALARMS_MAX_LIMIT, type ApiAlarm } from '../api/alarms'
import { DemoBadge } from '../components/DemoBadge'
import { KpiCard } from '../components/KpiCard'
import { Panel } from '../components/Panel'
import toggles from '../components/PeriodControls.module.css'
import { WidgetState, type WidgetStatus } from '../components/WidgetState'
import type { AlarmSeverity, Origin, Site } from '../data/types'
import { AlarmItem, useSiteAlarms } from '../widgets/SiteAlarmsPanel'
import list from '../widgets/List.module.css'
import styles from './AlarmsPage.module.css'

const browserFetch: typeof fetch = (...args) => fetch(...args)

type StateFilter = 'all' | 'active' | 'unacknowledged' | 'closed'
type SeverityFilter = 'all' | AlarmSeverity

const STATE_OPTIONS: ReadonlyArray<{ value: StateFilter; label: string }> = [
  { value: 'all', label: 'Wszystkie' },
  { value: 'active', label: 'Aktywne' },
  { value: 'unacknowledged', label: 'Niepotwierdzone' },
  { value: 'closed', label: 'Zamknięte' },
]

const SEVERITY_OPTIONS: ReadonlyArray<{ value: SeverityFilter; label: string }> = [
  { value: 'all', label: 'Każdy priorytet' },
  { value: 'CRITICAL', label: 'Krytyczne' },
  { value: 'WARNING', label: 'Ostrzeżenia' },
  { value: 'INFO', label: 'Informacje' },
]

/** Alarm spełnia filtry stanu i priorytetu. */
export function matches(alarm: ApiAlarm, state: StateFilter, severity: SeverityFilter): boolean {
  if (severity !== 'all' && alarm.severity !== severity) return false
  if (state === 'active') return alarm.closedAt === null
  if (state === 'unacknowledged') return alarm.acknowledgedAt === null
  if (state === 'closed') return alarm.closedAt !== null
  return true
}

/** Liczby do kart podsumowania: aktywne według priorytetu, niepotwierdzone i zamknięte. */
export function summarize(alarms: readonly ApiAlarm[]) {
  const active = alarms.filter((a) => a.closedAt === null)
  return {
    critical: active.filter((a) => a.severity === 'CRITICAL').length,
    warning: active.filter((a) => a.severity === 'WARNING').length,
    unacknowledged: alarms.filter((a) => a.acknowledgedAt === null).length,
    closed: alarms.length - active.length,
  }
}

function Toggles<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: ReadonlyArray<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className={toggles.group} role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={toggles.toggle}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/**
 * Strona „Alarmy” instalacji (D55, D74): podsumowanie, filtry stanu i priorytetu oraz lista z
 * potwierdzaniem. Dane jak panel dashboardu — otwarte i zamknięte w ostatnich 24 h (do 200).
 */
export function AlarmsPage({
  site,
  origin,
  fetchFn = browserFetch,
}: {
  site: Site
  /** W trybie DEMO alarmy z serwera nie istnieją. */
  origin: Origin
  fetchFn?: typeof fetch
}) {
  if (origin === 'DEMO') {
    return (
      <Panel title="Alarmy" actions={<DemoBadge origin="DEMO" />}>
        <WidgetState status={{ kind: 'empty', message: 'Alarmy wymagają serwera — niedostępne w trybie DEMO.' }} />
      </Panel>
    )
  }
  return <Alarms site={site} fetchFn={fetchFn} />
}

function Alarms({ site, fetchFn }: { site: Site; fetchFn: typeof fetch }) {
  const { state, ready, reload, canAcknowledge, busy, error, acknowledge } = useSiteAlarms(
    site.id,
    fetchFn,
    ALARMS_MAX_LIMIT,
  )
  const [stateFilter, setStateFilter] = useState<StateFilter>('all')
  const [severity, setSeverity] = useState<SeverityFilter>('all')

  const alarms = ready?.data.alarms ?? []
  const shown = alarms.filter((a) => matches(a, stateFilter, severity))
  const counts = summarize(alarms)
  const card = (value: number) => (ready ? String(value) : '—')

  let status: WidgetStatus
  if (state.status === 'loading') status = { kind: 'loading' }
  else if (state.status === 'error') status = { kind: 'error', onRetry: reload }
  else if (alarms.length === 0) status = { kind: 'empty', message: 'Brak alarmów z ostatnich 24 h.' }
  else if (shown.length === 0) status = { kind: 'empty', message: 'Żaden alarm nie pasuje do filtrów.' }
  else status = { kind: 'ready' }

  return (
    <div className={styles.page}>
      <section className={styles.summary} aria-label="Podsumowanie alarmów">
        <KpiCard label="Krytyczne aktywne" icon={OctagonAlert} value={card(counts.critical)} stale={false} />
        <KpiCard label="Ostrzeżenia aktywne" icon={AlertTriangle} value={card(counts.warning)} stale={false} />
        <KpiCard label="Niepotwierdzone" icon={BellRing} value={card(counts.unacknowledged)} stale={false} />
        <KpiCard label="Zamknięte (24 h)" icon={CheckCheck} value={card(counts.closed)} stale={false} />
      </section>
      <Panel
        title="Lista alarmów"
        actions={ready ? <span className={styles.count}>{`Pokazane: ${shown.length} z ${alarms.length}`}</span> : null}
      >
        <div className={styles.filters}>
          <Toggles label="Stan alarmu" options={STATE_OPTIONS} value={stateFilter} onChange={setStateFilter} />
          <Toggles label="Priorytet" options={SEVERITY_OPTIONS} value={severity} onChange={setSeverity} />
        </div>
        <WidgetState
          status={status}
          staleNotice={ready?.failed ? 'Nie udało się odświeżyć — alarmy z poprzedniego pobrania.' : null}
        >
          {error ? (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          ) : null}
          <ul className={list.list}>
            {shown.map((alarm) => (
              <AlarmItem
                key={alarm.id}
                alarm={alarm}
                timeZone={site.timezone}
                canAcknowledge={canAcknowledge}
                busy={busy === alarm.id}
                onAcknowledge={() => void acknowledge(alarm)}
              />
            ))}
          </ul>
        </WidgetState>
      </Panel>
    </div>
  )
}
