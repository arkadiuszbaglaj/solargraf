import { lazy, Suspense, useMemo, useState } from 'react'
import type { History } from '../api/history'
import type { HistoryRange, SeriesKey, SystemMetrics } from '../api/system'
import { HISTORY_RANGES, getSystemMetrics } from '../api/system'
import { Panel } from '../components/Panel'
import { WidgetState } from '../components/WidgetState'
import { hasValues } from '../components/historyChartOption'
import { usePeriodic } from '../hooks/usePeriodic'
import { formatBytes, formatDateTime } from '../lib/format'
import historyStyles from './DeviceHistoryPage.module.css'
import styles from './ServerHealthPage.module.css'

// ECharts ładowany osobno — nie blokuje pierwszego renderu strony.
const HistoryChartView = lazy(() =>
  import('../components/HistoryChartView').then((m) => ({ default: m.HistoryChartView })),
)

export const RANGE_LABEL: Record<HistoryRange, string> = { '24h': '24 h', '7d': '7 dni', '30d': '30 dni' }

const SERIES: Array<{ key: SeriesKey; title: string; empty: string }> = [
  { key: 'cpu_percent', title: 'Użycie procesora', empty: 'Brak danych w tym okresie.' },
  { key: 'memory_percent', title: 'Zajętość RAM', empty: 'Brak danych w tym okresie.' },
  { key: 'disk_percent', title: 'Zajętość dysku', empty: 'Brak danych w tym okresie.' },
  { key: 'cpu_temp_c', title: 'Temperatura procesora', empty: 'Parametr niedostępny na tym serwerze.' },
]

/**
 * Seria serwera w kształcie historii wykresu (D47), żeby użyć tego samego wykresu.
 * `resolution` steruje tu tylko znacznikami punktów (dla żadnego zakresu ich nie ma).
 */
export function toHistory(metrics: SystemMetrics, key: SeriesKey, timeZone: string): History {
  const series = metrics.series[key]
  return {
    metric: key,
    channel: null,
    unit: series.unit,
    cumulative: false,
    resolution: metrics.range === '24h' ? '5m' : '1h',
    timezone: timeZone,
    origins: [],
    points: series.points.map((p) => ({ t: p.t, value: p.avg, min: null, max: p.max, coverage: null })),
  }
}

/** Tekst prognozy zapełnienia dysku (D61) — zawsze jako szacunek. */
export function forecastText(forecast: SystemMetrics['diskForecast'], now: Date, timeZone: string): string {
  const growth =
    forecast.growthBytesPerDay !== null && forecast.growthBytesPerDay > 0
      ? ` przy przyroście ok. ${formatBytes(forecast.growthBytesPerDay)} na dobę`
      : ''
  switch (forecast.status) {
    case 'OK': {
      if (forecast.fullAt === null) return 'Brak prognozy.'
      const days = Math.floor((Date.parse(forecast.fullAt) - now.getTime()) / 86_400_000)
      const when = days < 1 ? 'w ciągu doby' : `za ok. ${days} ${days === 1 ? 'dzień' : 'dni'}`
      return `Szacunek: dysk zapełni się ${when} (${formatDateTime(forecast.fullAt, timeZone)})${growth}.`
    }
    case 'OVER_YEAR':
      return `Szacunek: dysk zapełni się za ponad rok${growth}.`
    case 'NOT_GROWING':
      return 'Zajętość dysku nie rośnie w ostatnich 7 dniach — brak prognozy zapełnienia.'
    case 'INSUFFICIENT_DATA':
      return 'Brak prognozy — potrzeba co najmniej 3 dni pomiarów z ostatnich 7 dni.'
  }
}

class MetricsUnavailable extends Error {}

function Charts({ metrics, timeZone }: { metrics: SystemMetrics; timeZone: string }) {
  const range = useMemo(() => ({ from: new Date(metrics.start), to: new Date(metrics.end) }), [metrics])
  const histories = useMemo(
    () =>
      SERIES.map(({ key, title, empty }) => ({ key, title, empty, history: toHistory(metrics, key, timeZone) })),
    [metrics, timeZone],
  )
  return (
    <div className={styles.charts}>
      {histories.map(({ key, title, empty, history }) => (
        <Panel key={key} title={`${title} [${history.unit}]`}>
          {hasValues(history) ? (
            <Suspense fallback={<WidgetState status={{ kind: 'loading' }} />}>
              <HistoryChartView
                history={history}
                timeZone={timeZone}
                range={range}
                label={`Wykres: ${title} w ${history.unit}, ostatnie ${RANGE_LABEL[metrics.range]}.`}
              />
            </Suspense>
          ) : (
            <WidgetState status={{ kind: 'empty', message: empty }} />
          )}
        </Panel>
      ))}
    </div>
  )
}

/** Historia 24 h / 7 dni / 30 dni i prognoza zapełnienia dysku (D61). */
export function ServerHistory({
  fetchFn,
  onExpired,
  timeZone,
}: {
  fetchFn: typeof fetch
  onExpired: () => void
  timeZone: string
}) {
  const [range, setRange] = useState<HistoryRange>('24h')
  const { state, reload } = usePeriodic<SystemMetrics | null>(`server-metrics:${range}`, async (_now, signal) => {
    const result = await getSystemMetrics(range, fetchFn, signal)
    if (result.kind === 'anonymous') {
      onExpired()
      throw new MetricsUnavailable()
    }
    if (result.kind === 'forbidden') return null
    if (result.kind === 'error') throw new MetricsUnavailable()
    return result.data
  })

  if (state.status === 'ready' && state.data === null) return null
  return (
    <section className={styles.history} aria-labelledby="server-history-title">
      <div className={styles.historyHeader}>
        <h2 id="server-history-title" className={styles.sectionTitle}>
          Historia
        </h2>
        <div className={historyStyles.group} role="group" aria-label="Zakres historii">
          {HISTORY_RANGES.map((r) => (
            <button
              key={r}
              type="button"
              className={historyStyles.toggle}
              aria-pressed={range === r}
              onClick={() => setRange(r)}
            >
              {RANGE_LABEL[r]}
            </button>
          ))}
        </div>
      </div>
      {state.status === 'loading' ? (
        <WidgetState status={{ kind: 'loading' }} />
      ) : state.status === 'error' || state.data === null ? (
        <WidgetState status={{ kind: 'error', onRetry: reload }} />
      ) : (
        <WidgetState
          status={{ kind: 'ready' }}
          staleNotice={state.failed ? 'Nie udało się odświeżyć historii. Pokazujemy ostatnie pobrane dane.' : null}
        >
          <Panel title="Prognoza zapełnienia dysku">
            <p className={styles.forecast}>{forecastText(state.data.diskForecast, new Date(state.data.end), timeZone)}</p>
            <p className={styles.muted}>
              Trend liniowy ze średnich godzinowych z ostatnich 7 dni. Jednorazowe zmiany (np. usunięcie kopii) mogą
              zaburzyć szacunek.
            </p>
          </Panel>
          <Charts metrics={state.data} timeZone={timeZone} />
          <p className="visually-hidden">Przerwy w linii wykresu oznaczają brak danych, a nie wartość zero.</p>
        </WidgetState>
      )}
    </section>
  )
}
