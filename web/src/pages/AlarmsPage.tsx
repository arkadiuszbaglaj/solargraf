import { AlertTriangle, BellRing, CheckCheck, OctagonAlert } from 'lucide-react'
import { useState } from 'react'
import {
  type AlarmHistoryDays,
  type AlarmPage,
  type AlarmQuery,
  type AlarmStateFilter,
  listAlarmPage,
} from '../api/alarms'
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

/** Alarmy na jedną stronę listy; „Pokaż więcej” dobiera kolejne. */
export const ALARMS_PAGE_SIZE = 50

type SeverityFilter = 'all' | AlarmSeverity

const STATE_OPTIONS: ReadonlyArray<{ value: AlarmStateFilter; label: string }> = [
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

type PeriodOption = 'd1' | 'd7' | 'd30' | 'd90' | 'd365'

interface Period {
  value: PeriodOption
  days: AlarmHistoryDays
  label: string
  span: string
}

const DAY: Period = { value: 'd1', days: 1, label: '24 h', span: '24 h' }

const PERIOD_OPTIONS: readonly Period[] = [
  DAY,
  { value: 'd7', days: 7, label: '7 dni', span: '7 dni' },
  { value: 'd30', days: 30, label: '30 dni', span: '30 dni' },
  { value: 'd90', days: 90, label: '90 dni', span: '90 dni' },
  { value: 'd365', days: 365, label: 'Rok', span: 'rok' },
]

const periodOf = (value: PeriodOption): Period => PERIOD_OPTIONS.find((p) => p.value === value) ?? DAY

/**
 * Pobiera `pages` kolejnych stron równolegle i skleja je bez powtórzeń (alarm mógł przesunąć się
 * między stronami). Liczby, `hasMore` i uprawnienia pochodzą z ostatniej strony.
 */
export async function loadAlarmPages(
  siteId: string,
  query: Omit<AlarmQuery, 'offset' | 'limit'>,
  pages: number,
  fetchFn: typeof fetch,
  signal: AbortSignal,
): Promise<AlarmPage> {
  const results = await Promise.all(
    Array.from({ length: Math.max(1, pages) }, (_, page) =>
      listAlarmPage(siteId, { ...query, offset: page * ALARMS_PAGE_SIZE, limit: ALARMS_PAGE_SIZE }, fetchFn, signal),
    ),
  )
  const loaded: AlarmPage[] = []
  for (const result of results) {
    if (result.kind !== 'ok') throw new Error('Nie udało się pobrać alarmów.')
    loaded.push(result.data)
  }
  const last = loaded.at(-1)
  if (!last) throw new Error('Nie udało się pobrać alarmów.')
  const seen = new Set<string>()
  const alarms = loaded.flatMap((page) => page.alarms).filter((a) => !seen.has(a.id) && Boolean(seen.add(a.id)))
  return { ...last, alarms }
}

const card = (value: number | undefined): string => (value === undefined ? '—' : String(value))

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
 * Strona „Alarmy” instalacji (D55, D74, D76): podsumowanie okresu, filtry stanu i priorytetu po
 * stronie serwera, stronicowanie „Pokaż więcej” i potwierdzanie. Historia dłuższa niż 24 h tylko
 * dla właściciela i administratora — przełącznik okresu pokazujemy, gdy serwer na to pozwala.
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
  const [period, setPeriod] = useState<PeriodOption>('d1')
  const [stateFilter, setStateFilter] = useState<AlarmStateFilter>('all')
  const [severity, setSeverity] = useState<SeverityFilter>('all')
  const [pages, setPages] = useState(1)
  const { days, span } = periodOf(period)
  const { state, ready, reload, canAcknowledge, busy, error, acknowledge } = useSiteAlarms(site.id, fetchFn, {
    key: `${days}|${stateFilter}|${severity}|${pages}`,
    load: (signal) => loadAlarmPages(site.id, { days, state: stateFilter, severity }, pages, fetchFn, signal),
  })

  // Zmiana filtra albo okresu zaczyna od pierwszej strony.
  const changePeriod = (value: PeriodOption) => {
    setPeriod(value)
    setPages(1)
  }
  const changeState = (value: AlarmStateFilter) => {
    setStateFilter(value)
    setPages(1)
  }
  const changeSeverity = (value: SeverityFilter) => {
    setSeverity(value)
    setPages(1)
  }

  const data = ready?.data ?? null
  const filtered = stateFilter !== 'all' || severity !== 'all'

  let status: WidgetStatus
  if (state.status === 'loading') status = { kind: 'loading' }
  else if (state.status === 'error') status = { kind: 'error', onRetry: reload }
  else if (state.data.alarms.length > 0) status = { kind: 'ready' }
  else if (filtered) status = { kind: 'empty', message: 'Żaden alarm nie pasuje do filtrów.' }
  else
    status = {
      kind: 'empty',
      message: days === 1 ? 'Brak alarmów z ostatnich 24 h.' : 'Brak alarmów w wybranym okresie.',
    }

  return (
    <div className={styles.page}>
      <section className={styles.summary} aria-label="Podsumowanie alarmów">
        <KpiCard label="Krytyczne aktywne" icon={OctagonAlert} value={card(data?.summary.criticalActive)} stale={false} />
        <KpiCard label="Ostrzeżenia aktywne" icon={AlertTriangle} value={card(data?.summary.warningActive)} stale={false} />
        <KpiCard label="Niepotwierdzone" icon={BellRing} value={card(data?.summary.unacknowledged)} stale={false} />
        <KpiCard label={`Zamknięte (${span})`} icon={CheckCheck} value={card(data?.summary.closed)} stale={false} />
      </section>
      <Panel
        title="Lista alarmów"
        actions={data ? <span className={styles.count}>{`Pokazane: ${data.alarms.length} z ${data.total}`}</span> : null}
      >
        <div className={styles.filters}>
          {data?.canViewHistory ? (
            <Toggles label="Okres" options={PERIOD_OPTIONS} value={period} onChange={changePeriod} />
          ) : null}
          <Toggles label="Stan alarmu" options={STATE_OPTIONS} value={stateFilter} onChange={changeState} />
          <Toggles label="Priorytet" options={SEVERITY_OPTIONS} value={severity} onChange={changeSeverity} />
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
            {data?.alarms.map((alarm) => (
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
          {data?.hasMore ? (
            <button type="button" className={styles.more} onClick={() => setPages((p) => p + 1)}>
              Pokaż więcej
            </button>
          ) : null}
        </WidgetState>
      </Panel>
    </div>
  )
}
