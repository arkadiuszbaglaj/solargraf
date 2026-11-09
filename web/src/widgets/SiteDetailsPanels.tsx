import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { LiveDevice } from '../api/live'
import { DemoBadge } from '../components/DemoBadge'
import { Panel } from '../components/Panel'
import { Ring } from '../components/Ring'
import { WidgetState } from '../components/WidgetState'
import type { LiveSite } from '../hooks/useLiveSite'
import { useNow } from '../hooks/useNow'
import { formatAge, formatQuantity, MISSING } from '../lib/format'
import {
  availableEnergyWh,
  batteryTime,
  type BatteryTime,
  cellVoltageSpread,
  detailSections,
  formatEstimate,
  sectionNumber,
  sectionValue,
  sectionValues,
  type DetailGroup,
  type DetailKey,
  type DetailRow,
  type DetailSection,
} from '../lib/siteDetails'
import { todayEnergy, type TodayState } from '../lib/today'
import { EnergyBalancePanel } from './EnergyBalancePanel'
import { MpptChart } from './MpptChart'
import styles from './SiteDetailsPanels.module.css'

/** Wartość ze znakiem (D39) jako moduł z opisem kierunku; reszta bez zmian. */
function valueText(r: DetailRow): { text: string; direction: string | null } {
  const v = r.value
  if (v.kind !== 'value') return { text: MISSING, direction: null }
  if (!r.signed) return { text: formatQuantity(v.value, r.unit, r.voltDigits), direction: null }
  const direction = v.value > 0 ? r.signed.positive : v.value < 0 ? r.signed.negative : 'brak przepływu'
  return { text: formatQuantity(Math.abs(v.value), r.unit), direction }
}

function status(r: DetailRow): string | null {
  const v = r.value
  switch (v.kind) {
    case 'value':
      return v.stale ? `nieaktualne, odczyt ${formatAge(v.ageSeconds)} temu` : null
    case 'no-data':
      return 'brak danych'
    case 'not-provided':
      return 'parametr niedostępny'
    case 'ambiguous':
      return `wiele źródeł (${v.sources}) — wartość niedostępna`
  }
}

/** Tekst komórki (wartość i ewentualny opis braku) — do tabeli faz. */
function cellText(r: DetailRow | null): { text: string; meta: string | null; stale: boolean } {
  if (!r) return { text: MISSING, meta: 'parametr niedostępny', stale: false }
  const { text, direction } = valueText(r)
  const meta = [direction, status(r)].filter(Boolean).join(' · ')
  return { text, meta: meta || null, stale: r.value.kind === 'value' && r.value.stale }
}

function Row({ row }: { row: DetailRow }) {
  const { text, meta, stale } = cellText(row)
  return (
    <div className={`${styles.row} ${stale ? styles.stale : ''}`}>
      <dt className={styles.label}>{row.label}</dt>
      <dd className={styles.value}>
        <span className={styles.number}>{text}</span>
        {meta ? <span className={styles.meta}>{meta}</span> : null}
      </dd>
    </div>
  )
}

/** Wiersz wartości wyliczonej albo dziennej (nie z bieżącego odczytu) z opisem pochodzenia. */
function ExtraRow({ label, value, meta }: { label: string; value: string; meta: string }) {
  return (
    <div className={styles.row}>
      <dt className={styles.label}>{label}</dt>
      <dd className={styles.value}>
        <span className={styles.number}>{value}</span>
        <span className={styles.meta}>{meta}</span>
      </dd>
    </div>
  )
}

function Rows({ rows, children }: { rows: DetailRow[]; children?: ReactNode }) {
  return (
    <dl className={styles.list}>
      {rows.map((r) => (
        <Row key={r.id} row={r} />
      ))}
      {children}
    </dl>
  )
}

interface ChartContext {
  siteId: string
  timeZone: string
  devices: readonly LiveDevice[]
  fetchFn?: typeof fetch
}

function StringGroup({ group, chart }: { group: DetailGroup; chart: ChartContext | null }) {
  return (
    <>
      <Rows rows={group.rows} />
      {chart && group.channel !== null ? (
        <div className={styles.chart}>
          <MpptChart
            siteId={chart.siteId}
            devices={chart.devices}
            channel={group.channel}
            timeZone={chart.timeZone}
            {...(chart.fetchFn ? { fetchFn: chart.fetchFn } : {})}
          />
        </div>
      ) : null}
    </>
  )
}

/** Zakładki MPPT (wzorzec ARIA tabs: strzałki, Home/End, aktywna zakładka w kolejności Tab). */
function StringTabs({ groups, chart }: { groups: DetailGroup[]; chart: ChartContext | null }) {
  const [selected, setSelected] = useState(0)
  const baseId = useId()
  const tabs = useRef<Array<HTMLButtonElement | null>>([])
  const active = Math.min(selected, groups.length - 1)
  const current = groups[active]

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const last = groups.length - 1
    const next =
      event.key === 'ArrowRight'
        ? (active + 1) % groups.length
        : event.key === 'ArrowLeft'
          ? (active - 1 + groups.length) % groups.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null
    if (next === null) return
    event.preventDefault()
    setSelected(next)
    tabs.current[next]?.focus()
  }

  return (
    <div className={styles.group}>
      <div role="tablist" aria-label="Stringi MPPT" className={styles.tabs}>
        {groups.map((g, i) => (
          <button
            key={g.title}
            ref={(el) => {
              tabs.current[i] = el
            }}
            type="button"
            role="tab"
            id={`${baseId}-tab-${i}`}
            aria-selected={i === active}
            aria-controls={`${baseId}-panel`}
            tabIndex={i === active ? 0 : -1}
            className={styles.tab}
            onClick={() => setSelected(i)}
            onKeyDown={onKeyDown}
          >
            {g.title}
          </button>
        ))}
      </div>
      {current ? (
        <div role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-tab-${active}`}>
          <StringGroup key={current.title} group={current} chart={chart} />
        </div>
      ) : null}
    </div>
  )
}

function PvBody({ section, chart }: { section: DetailSection; chart: ChartContext | null }) {
  const main = section.groups.filter((g) => g.channel === null)
  const strings = section.groups.filter((g) => g.channel !== null)
  return (
    <>
      {main.map((g) => (
        <div key="main" className={styles.group}>
          <Rows rows={g.rows} />
        </div>
      ))}
      {strings.length > 1 ? <StringTabs groups={strings} chart={chart} /> : null}
      {strings.length === 1 && strings[0] ? (
        <div className={styles.group}>
          <h3 className={styles.groupTitle}>{strings[0].title}</h3>
          <StringGroup group={strings[0]} chart={chart} />
        </div>
      ) : null}
    </>
  )
}

function BatteryBody({ section }: { section: DetailSection }) {
  const soc = sectionNumber(section, 'battery_soc')
  const capacity = sectionNumber(section, 'battery_capacity')
  const available = availableEnergyWh(soc, capacity)
  const time = batteryTime(sectionValue(section, 'battery_soc'), sectionValue(section, 'battery_power'), capacity)
  const rows = section.groups.flatMap((g) => g.rows)
  const socRow = rows.find((r) => r.id === 'battery_soc|0')
  return (
    <>
      <div className={styles.batteryTop}>
        {socRow ? (
          <Ring percent={soc}>
            <span className={styles.ringValue}>{soc === null ? MISSING : formatQuantity(soc, '%')}</span>
            <span className={styles.ringLabel}>SoC</span>
          </Ring>
        ) : null}
        <Rows rows={rows.filter((r) => r !== socRow)} />
      </div>
      {available !== null && capacity !== null ? (
        <div className={styles.estimate}>
          <p className={styles.estimateText}>
            <span>Energia w magazynie (szacunek)</span>
            <strong>
              {formatQuantity(available, 'Wh')} <span className={styles.meta}>z {formatQuantity(capacity, 'Wh')}</span>
            </strong>
          </p>
          <div className={styles.bar} aria-hidden="true">
            <span className={styles.barFill} style={{ width: `${(available / capacity) * 100}%` }} />
          </div>
          <p className={styles.meta}>Stan naładowania × pojemność nominalna; bez rezerwy i zużycia ogniw.</p>
          {time ? <BatteryTimeText time={time} /> : null}
        </div>
      ) : null}
    </>
  )
}

/** Szacunek czasu przy obecnej mocy (D71) — do 100% albo do 0% SoC, bez rezerwy falownika. */
function BatteryTimeText({ time }: { time: BatteryTime }) {
  if (time.kind === 'idle') return null
  const [label, value] =
    time.kind === 'charging'
      ? ['Pełne naładowanie za', formatEstimate(time.seconds)]
      : time.kind === 'discharging'
        ? ['Energii wystarczy na', formatEstimate(time.seconds)]
        : time.kind === 'full'
          ? ['Magazyn', 'naładowany']
          : ['Magazyn', 'rozładowany']
  return (
    <>
      <p className={styles.estimateText}>
        <span>{label}</span>
        <strong>{value}</strong>
      </p>
      {time.kind === 'charging' || time.kind === 'discharging' ? (
        <p className={styles.meta}>
          Szacunek przy obecnej mocy, do {time.kind === 'charging' ? '100%' : '0%'} stanu naładowania; bez rezerwy
          falownika i strat.
        </p>
      ) : null}
    </>
  )
}

function GridBody({ section, today }: { section: DetailSection; today: TodayState | undefined }) {
  const captionId = useId()
  const hasVoltage = section.phases.some((p) => p.voltage)
  const hasCurrent = section.phases.some((p) => p.current)
  const rows = section.groups.flatMap((g) => g.rows)
  return (
    <>
      {rows.length > 0 || today ? (
        <div className={styles.group}>
          <Rows rows={rows}>
            {today ? (
              <>
                <ExtraRow label="Pobrane dziś" value={todayEnergy(today, 'grid_import')} meta="od północy" />
                <ExtraRow label="Oddane dziś" value={todayEnergy(today, 'grid_export')} meta="od północy" />
              </>
            ) : null}
          </Rows>
        </div>
      ) : null}
      {section.phases.length > 0 ? (
        <div className={styles.group}>
          <table className={styles.phases} aria-describedby={captionId}>
            <caption id={captionId} className="visually-hidden">
              Napięcie i prąd faz sieci
            </caption>
            <thead>
              <tr>
                <th scope="col">Faza</th>
                {hasVoltage ? <th scope="col">Napięcie</th> : null}
                {hasCurrent ? <th scope="col">Prąd</th> : null}
              </tr>
            </thead>
            <tbody>
              {section.phases.map((p) => (
                <tr key={p.channel}>
                  <th scope="row">{p.label}</th>
                  {hasVoltage ? <PhaseCell row={p.voltage} /> : null}
                  {hasCurrent ? <PhaseCell row={p.current} /> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  )
}

function PhaseCell({ row }: { row: DetailRow | null }) {
  const { text, meta, stale } = cellText(row)
  return (
    <td className={stale ? styles.stale : undefined}>
      <span className={styles.number}>{text}</span>
      {meta ? <span className={styles.meta}>{meta}</span> : null}
    </td>
  )
}

function BmsBody({ section }: { section: DetailSection }) {
  const spread = cellVoltageSpread(
    sectionNumber(section, 'battery_cell_voltage_min'),
    sectionNumber(section, 'battery_cell_voltage_max'),
  )
  return (
    <>
      {section.groups.map((g) => (
        <div key="main" className={styles.group}>
          <Rows rows={g.rows}>
            {spread !== null ? (
              <ExtraRow
                label="Różnica napięć ogniw"
                value={formatQuantity(spread, 'V', 3)}
                meta="wyliczona: maks. − min."
              />
            ) : null}
          </Rows>
        </div>
      ))}
    </>
  )
}

function SectionPanel({
  section,
  chart,
  today,
}: {
  section: DetailSection
  chart: ChartContext | null
  today: TodayState | undefined
}) {
  const values = sectionValues(section)
  const simulated = values.some((v) => v.kind === 'value' && v.origin === 'SIMULATED')
  let body: ReactNode
  switch (section.key) {
    case 'pv':
      body = <PvBody section={section} chart={chart} />
      break
    case 'battery':
      body = <BatteryBody section={section} />
      break
    case 'grid':
      body = <GridBody section={section} today={today} />
      break
    case 'bms':
      body = <BmsBody section={section} />
      break
  }
  return (
    <Panel
      title={section.title}
      actions={
        <>
          {simulated ? <DemoBadge origin="SIMULATED" /> : null}
        </>
      }
    >
      {body}
    </Panel>
  )
}

/** Panel szczegółów: sekcja z odczytów albo bilans dnia („Zużycie i samowystarczalność”). */
export type DetailPanelKey = DetailKey | 'balance'

const ALL_PANELS: readonly DetailPanelKey[] = ['pv', 'battery', 'grid', 'balance', 'bms']

/**
 * Szczegóły PV, magazynu energii, sieci i BMS (D56, D69) z tego samego strumienia co karty
 * i diagram, oraz bilans dnia. Panel i wiersz tylko dla metryk, które profil udostępnia.
 * Wykres MPPT i energia dzienna tylko z `siteId`/`today` (dashboard z API). `panels` wybiera
 * panele i ich kolejność (dashboard dzieli je na dwa rzędy); `className` — układ grupy.
 */
export function SiteDetailsPanels({
  live,
  now: fixedNow,
  siteId,
  timeZone,
  today,
  fetchFn,
  panels = ALL_PANELS,
  label = 'Szczegóły instalacji',
  className,
}: {
  live: LiveSite
  now?: Date
  siteId?: string
  timeZone?: string
  today?: TodayState
  fetchFn?: typeof fetch
  panels?: readonly DetailPanelKey[]
  label?: string
  className?: string | undefined
}) {
  const tickingNow = useNow(1000)
  const now = fixedNow ?? tickingNow
  const { state, retry } = live

  if (state.status === 'connecting' || state.status === 'error') {
    return (
      <Panel title={label}>
        <WidgetState status={state.status === 'connecting' ? { kind: 'loading' } : { kind: 'error', onRetry: retry }} />
      </Panel>
    )
  }

  const sections = detailSections(state.devices, state.readings, now)
  const chart: ChartContext | null =
    siteId && timeZone ? { siteId, timeZone, devices: state.devices, ...(fetchFn ? { fetchFn } : {}) } : null
  const shown: ReactNode[] = []
  for (const key of panels) {
    if (key === 'balance') {
      if (today) shown.push(<EnergyBalancePanel key="balance" today={today} />)
      continue
    }
    const s = sections.find((x: DetailSection) => x.key === key)
    if (s) shown.push(<SectionPanel key={s.key} section={s} chart={chart} today={today} />)
  }
  if (shown.length === 0) return null
  return (
    <section aria-label={label} className={className ?? styles.panels}>
      {shown}
    </section>
  )
}
