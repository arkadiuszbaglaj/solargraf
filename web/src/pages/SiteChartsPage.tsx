import { lazy, Suspense, useId, useMemo, useState, type FormEvent } from 'react'
import { assignLocation, loginUrl } from '../api/auth'
import { DemoBadge } from '../components/DemoBadge'
import { Panel } from '../components/Panel'
import { CALENDAR_PERIODS, PeriodControls, type PeriodOption } from '../components/PeriodControls'
import { WidgetState, type WidgetStatus } from '../components/WidgetState'
import { RESOLUTION_LABEL } from '../components/historyChartOption'
import type { Origin, Site } from '../data/types'
import { useAsync } from '../hooks/useAsync'
import {
  FULL_ZOOM,
  isFullZoom,
  panZoom,
  visibleRange,
  type Zoom,
  zoomIn,
  zoomOut,
} from '../lib/chartZoom'
import { customRange, type Period, rangeFor, shiftAnchor, today } from '../lib/historyRange'
import { type LoadedSeries, loadSiteHistory, SessionExpiredError, seriesHasValues } from '../lib/siteHistory'
import { localDate } from '../lib/time'
import { SiteEnergyPanel } from './SiteEnergyPanel'
import styles from './SiteChartsPage.module.css'

// ECharts ładowany osobno — nie blokuje pierwszego renderu strony.
const SiteHistoryChartView = lazy(() =>
  import('../components/SiteHistoryChartView').then((m) => ({ default: m.SiteHistoryChartView })),
)

type Choice = Period | 'custom'

const OPTIONS: Array<PeriodOption<Choice>> = [...CALENDAR_PERIODS, { value: 'custom', label: 'Własny' }]

const browserFetch: typeof fetch = (...args) => fetch(...args)

/**
 * Przyciski przybliżenia wspólne dla wykresów strony — także z klawiatury (suwak ECharts jej nie
 * obsługuje). Pokazuje widoczny fragment, gdy wykres jest przybliżony.
 */
function ZoomControls({
  zoom,
  onZoom,
  range,
  timeZone,
}: {
  zoom: Zoom
  onZoom: (zoom: Zoom) => void
  range: { from: Date; to: Date }
  timeZone: string
}) {
  const full = isFullZoom(zoom)
  const visible = visibleRange(range, zoom)
  const fmt = new Intl.DateTimeFormat('pl-PL', { timeZone, dateStyle: 'short', timeStyle: 'short' })
  return (
    <div className={styles.zoom}>
      <div className={styles.zoomButtons} role="group" aria-label="Przybliżenie wykresów">
        <button type="button" className={styles.zoomButton} onClick={() => onZoom(zoomIn(zoom))} disabled={zoom.end - zoom.start <= 1}>
          Przybliż
        </button>
        <button type="button" className={styles.zoomButton} onClick={() => onZoom(zoomOut(zoom))} disabled={full}>
          Oddal
        </button>
        <button type="button" className={styles.zoomButton} onClick={() => onZoom(panZoom(zoom, -1))} disabled={zoom.start <= 0}>
          ← Wcześniej
        </button>
        <button type="button" className={styles.zoomButton} onClick={() => onZoom(panZoom(zoom, 1))} disabled={zoom.end >= 100}>
          Później →
        </button>
        <button type="button" className={styles.zoomButton} onClick={() => onZoom(FULL_ZOOM)} disabled={full}>
          Cały okres
        </button>
      </div>
      <p className={styles.muted} aria-live="polite">
        {full
          ? 'Zaznacz fragment wykresu myszą, użyj suwaka pod wykresem albo Ctrl + kółka myszy, aby przybliżyć.'
          : `Widoczne: ${fmt.format(visible.from)} – ${fmt.format(visible.to)}`}
      </p>
    </div>
  )
}

/**
 * Wykresy i historia instalacji (D66): moc PV, zużycia, sieci i baterii oraz SoC dla wybranego
 * okresu w strefie instalacji. Dane z API historii urządzeń-źródeł; luki jako przerwy w liniach.
 */
export function SiteChartsPage({
  site,
  now,
  origin,
  fetchFn = browserFetch,
  navigate = assignLocation,
}: {
  site: Site
  now: Date
  /** Pochodzenie źródła danych aplikacji — w trybie DEMO historia z serwera nie istnieje. */
  origin: Origin
  fetchFn?: typeof fetch
  navigate?: (url: string) => void
}) {
  if (origin === 'DEMO') {
    return (
      <Panel title="Wykresy i historia" actions={<DemoBadge origin="DEMO" />}>
        <WidgetState
          status={{ kind: 'empty', message: 'Historia pomiarów wymaga serwera — niedostępna w trybie DEMO.' }}
        />
      </Panel>
    )
  }
  return <Charts site={site} now={now} fetchFn={fetchFn} navigate={navigate} />
}

function Charts({
  site,
  now,
  fetchFn,
  navigate,
}: {
  site: Site
  now: Date
  fetchFn: typeof fetch
  navigate: (url: string) => void
}) {
  const tz = site.timezone
  const todayDate = today(now, tz)
  const [choice, setChoice] = useState<Choice>('day')
  const [anchor, setAnchor] = useState(todayDate)
  // Zastosowany zakres własny (zawsze poprawny) i wersja robocza pól formularza.
  const [custom, setCustom] = useState({ from: todayDate, to: todayDate })
  const [draft, setDraft] = useState(custom)
  const [error, setError] = useState<string | null>(null)
  const fromId = useId()
  const toId = useId()
  const errorId = useId()

  const range = useMemo(() => {
    if (choice !== 'custom') return rangeFor(anchor, choice, tz)
    const r = customRange(custom.from, custom.to, tz)
    return r.kind === 'ok' ? r.range : rangeFor(anchor, 'day', tz)
  }, [choice, anchor, custom, tz])
  const isCurrent = range.from <= now && now < range.to
  // Przybliżenie dotyczy oglądanego zakresu — po zmianie okresu wraca cały zakres.
  const rangeKey = `${range.from.getTime()}-${range.to.getTime()}`
  const [zoomState, setZoomState] = useState<{ key: string; zoom: Zoom }>({ key: rangeKey, zoom: FULL_ZOOM })
  const zoom = zoomState.key === rangeKey ? zoomState.zoom : FULL_ZOOM
  const setZoom = (next: Zoom) => setZoomState({ key: rangeKey, zoom: next })

  const { state, reload } = useAsync(
    async (signal) => {
      try {
        return await loadSiteHistory(site.id, range, fetchFn, signal)
      } catch (e) {
        if (e instanceof SessionExpiredError) navigate(loginUrl('expired'))
        throw e
      }
    },
    [site.id, range, fetchFn, navigate],
  )

  const choose = (next: Choice) => {
    if (next === 'custom' && choice !== 'custom') {
      // Zakres własny startuje od aktualnie oglądanego okresu.
      const dates = { from: localDate(range.from, tz), to: localDate(new Date(range.to.getTime() - 1), tz) }
      setCustom(dates)
      setDraft(dates)
      setError(null)
    }
    setChoice(next)
  }

  const apply = (e: FormEvent) => {
    e.preventDefault()
    const r = customRange(draft.from, draft.to, tz)
    if (r.kind === 'invalid') {
      setError(r.message)
      return
    }
    setError(null)
    setCustom(draft)
  }

  const data = state.status === 'ready' ? state.data : null
  const badges = data ? (
    <span className={styles.badges}>
      {data.origins.includes('DEMO') ? <DemoBadge origin="DEMO" /> : null}
      {data.origins.includes('SIMULATED') ? <DemoBadge origin="SIMULATED" /> : null}
    </span>
  ) : null

  const status = (series: readonly LoadedSeries[], none: string): WidgetStatus => {
    if (state.status === 'loading') return { kind: 'loading' }
    if (state.status === 'error') return { kind: 'error', onRetry: reload }
    if (series.length === 0) return { kind: 'empty', message: none }
    if (!series.some(seriesHasValues)) return { kind: 'empty', message: 'Brak danych w tym okresie.' }
    return { kind: 'ready' }
  }

  return (
    <div className={styles.page}>
      <Panel title={`Moc — ${site.name}`} actions={badges}>
        <div className={styles.controls}>
          <PeriodControls
            options={OPTIONS}
            value={choice}
            onChange={choose}
            nav={
              choice === 'custom'
                ? null
                : {
                    onPrev: () => setAnchor(shiftAnchor(anchor, choice, -1)),
                    onToday: () => setAnchor(todayDate),
                    onNext: () => setAnchor(shiftAnchor(anchor, choice, 1)),
                    isCurrent,
                    nextDisabled: range.to > now,
                  }
            }
          />
          {choice === 'custom' ? (
            <form className={styles.custom} onSubmit={apply} noValidate>
              <div className={styles.field}>
                <label htmlFor={fromId}>Od</label>
                <input
                  id={fromId}
                  type="date"
                  value={draft.from}
                  max={todayDate}
                  aria-invalid={error !== null}
                  aria-describedby={error ? errorId : undefined}
                  onChange={(e) => setDraft({ ...draft, from: e.target.value })}
                />
              </div>
              <div className={styles.field}>
                <label htmlFor={toId}>Do</label>
                <input
                  id={toId}
                  type="date"
                  value={draft.to}
                  max={todayDate}
                  aria-invalid={error !== null}
                  aria-describedby={error ? errorId : undefined}
                  onChange={(e) => setDraft({ ...draft, to: e.target.value })}
                />
              </div>
              <button type="submit" className={styles.apply}>
                Pokaż
              </button>
              {error ? (
                <p id={errorId} className={styles.error} role="alert">
                  {error}
                </p>
              ) : null}
            </form>
          ) : null}
        </div>
        <p className={styles.range} aria-live="polite">
          {range.label}
          {data?.resolution ? (
            <span className={styles.muted}> · rozdzielczość: {RESOLUTION_LABEL[data.resolution]}</span>
          ) : null}
        </p>
        {data && (data.power.some(seriesHasValues) || (data.soc !== null && seriesHasValues(data.soc))) ? (
          <ZoomControls zoom={zoom} onZoom={setZoom} range={range} timeZone={tz} />
        ) : null}
        <WidgetState
          status={status(data?.power ?? [], 'Urządzenia instalacji nie podają mocy PV, zużycia, sieci ani baterii.')}
        >
          {data ? (
            <Suspense fallback={<WidgetState status={{ kind: 'loading' }} />}>
              <SiteHistoryChartView
                series={data.power}
                timeZone={tz}
                range={range}
                label={`Wykres mocy w kW: ${data.power.map((s) => s.name).join(', ')}; ${range.label}.`}
                zoom={zoom}
                onZoom={setZoom}
              />
            </Suspense>
          ) : null}
        </WidgetState>
        {data && data.missing.length > 0 ? (
          <p className={styles.muted}>Niedostępne: {data.missing.join('; ')}.</p>
        ) : null}
        <p className="visually-hidden">Przerwy w liniach wykresów oznaczają brak danych, a nie wartość zero.</p>
      </Panel>
      {data?.soc ? (
        <Panel title="Stan naładowania baterii" actions={badges}>
          <WidgetState status={status([data.soc], '')}>
            <Suspense fallback={<WidgetState status={{ kind: 'loading' }} />}>
              <SiteHistoryChartView
                series={[data.soc]}
                timeZone={tz}
                range={range}
                label={`Wykres stanu naładowania baterii w %; ${range.label}.`}
                zoom={zoom}
                onZoom={setZoom}
                slider={false}
              />
            </Suspense>
          </WidgetState>
        </Panel>
      ) : null}
      <SiteEnergyPanel siteId={site.id} range={range} timeZone={tz} fetchFn={fetchFn} navigate={navigate} />
    </div>
  )
}
