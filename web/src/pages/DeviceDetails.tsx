import { lazy, Suspense, useId, useState } from 'react'
import type { ApiDevice, ApiDeviceMetric } from '../api/devices'
import type { History } from '../api/history'
import { getHistory } from '../api/history'
import { DemoBadge } from '../components/DemoBadge'
import { SupportLevelLabel } from '../components/SupportLevelLabel'
import { WidgetState } from '../components/WidgetState'
import { formatValue, hasValues } from '../components/historyChartOption'
import type { LiveState } from '../hooks/useLiveSite'
import { usePeriodic } from '../hooks/usePeriodic'
import { KIND_LABEL, STATUS_LABEL } from '../lib/deviceLabels'
import { CHART_SPANS, type ChartSpan, chartMetrics, metricId, metricLabel, spanRange } from '../lib/deviceList'
import { MISSING, formatAge, formatDateTime } from '../lib/format'
import { deviceValue } from '../lib/liveValues'
import styles from './DevicesPage.module.css'

// ECharts ładowany osobno — nie blokuje pierwszego renderu strony.
const HistoryChartView = lazy(() =>
  import('../components/HistoryChartView').then((m) => ({ default: m.HistoryChartView })),
)

/** Odświeżanie małego wykresu — agregaty 5-minutowe (D46) nie zmieniają się częściej. */
export const DEVICE_CHART_REFRESH_MS = 5 * 60_000

class SessionExpired extends Error {}

/** Panel szczegółów urządzenia: bieżące wartości (SSE), wykres, połączenie i profil. */
export function DeviceDetails({
  device,
  siteId,
  timeZone,
  now,
  live,
  canManage,
  busy,
  onToggle,
  onExpired,
  historyUrl,
  fetchFn,
}: {
  device: ApiDevice
  siteId: string
  timeZone: string
  now: Date
  live: LiveState
  canManage: boolean
  busy: boolean
  onToggle: () => void
  onExpired: () => void
  historyUrl: string
  fetchFn: typeof fetch
}) {
  const headingId = useId()
  const simulatedProfile = device.details?.profileId?.startsWith('simulated.') ?? false
  const subtitle = [device.manufacturer, device.model].filter(Boolean).join(' ')
  return (
    <section className={styles.details} aria-labelledby={headingId}>
      <header className={styles.detailsHeader}>
        <div>
          <h2 id={headingId} className={styles.detailsTitle} tabIndex={-1}>
            {device.name}
          </h2>
          <p className={styles.muted}>
            {KIND_LABEL[device.kind] ?? device.kind}
            {subtitle ? ` · ${subtitle}` : ''}
          </p>
        </div>
        <span className={`${styles.status} ${styles[device.status]}`}>
          <span className={styles.dot} aria-hidden="true" />
          {STATUS_LABEL[device.status]}
        </span>
      </header>

      <CurrentValues device={device} live={live} now={now} />

      <DeviceChart
        device={device}
        siteId={siteId}
        timeZone={timeZone}
        historyUrl={historyUrl}
        onExpired={onExpired}
        fetchFn={fetchFn}
      />

      <div>
        <h3 className={styles.subTitle}>Połączenie i profil</h3>
        <dl className={styles.facts}>
          <dt>Ostatni odczyt</dt>
          <dd>{device.lastSuccessAt ? formatDateTime(device.lastSuccessAt, timeZone) : MISSING}</dd>
          <dt>Wsparcie profilu</dt>
          <dd>
            <SupportLevelLabel level={device.supportLevel} />
          </dd>
          {device.details ? (
            <>
              <dt>Połączenie</dt>
              <dd>{device.details.connection.name}</dd>
              <dt>Adres</dt>
              <dd>
                {device.details.connection.host
                  ? `${device.details.connection.host}:${device.details.connection.port ?? 502}`
                  : MISSING}
              </dd>
              <dt>Unit ID</dt>
              <dd>{device.details.connection.unitId ?? MISSING}</dd>
              <dt>Interwał odczytu</dt>
              <dd>
                {device.details.connection.pollIntervalSeconds !== null
                  ? `${device.details.connection.pollIntervalSeconds} s`
                  : 'z profilu'}
              </dd>
              <dt>Profil</dt>
              <dd>
                {device.details.profileId
                  ? `${device.details.profileId}${device.details.profileVersion ? ` (${device.details.profileVersion})` : ''}`
                  : MISSING}
                {simulatedProfile ? <span className={styles.simulated}> SIMULATED</span> : null}
              </dd>
              <dt>Wersja firmware</dt>
              <dd>{device.details.firmwareVersion ?? 'niedostępna'}</dd>
              <dt>Numer seryjny</dt>
              <dd>{device.details.serialNumber ?? 'niedostępny'}</dd>
            </>
          ) : null}
        </dl>
      </div>

      {canManage ? (
        <div className={styles.detailsActions}>
          <button
            type="button"
            className={styles.secondary}
            disabled={busy}
            aria-label={`${device.enabled ? 'Wyłącz' : 'Włącz'} urządzenie ${device.name}`}
            onClick={onToggle}
          >
            {device.enabled ? 'Wyłącz odczyt' : 'Włącz odczyt'}
          </button>
        </div>
      ) : null}
    </section>
  )
}

/** Ostatnie odczyty wszystkich metryk urządzenia ze strumienia na żywo (D50); brak to „—”, nie 0. */
function CurrentValues({ device, live, now }: { device: ApiDevice; live: LiveState; now: Date }) {
  const title = <h3 className={styles.subTitle}>Bieżące wartości</h3>
  if (device.metrics.length === 0) {
    return (
      <div>
        {title}
        <p className={styles.muted}>Profil urządzenia nie udostępnia żadnych pomiarów.</p>
      </div>
    )
  }
  if (live.status === 'connecting') {
    return (
      <div>
        {title}
        <WidgetState status={{ kind: 'loading' }} />
      </div>
    )
  }
  if (live.status === 'error') {
    return (
      <div>
        {title}
        <p className={styles.muted}>Brak połączenia z danymi na żywo — wartości niedostępne.</p>
      </div>
    )
  }
  const liveDevice = live.devices.find((d) => d.id === device.id)
  const rows = device.metrics.map((m) => ({
    metric: m,
    value: liveDevice ? deviceValue(liveDevice, live.readings, m.key, now, m.channel) : null,
  }))
  const simulated = rows.some((r) => r.value?.kind === 'value' && r.value.origin === 'SIMULATED')
  return (
    <div>
      <div className={styles.subHeader}>
        {title}
        {simulated ? <DemoBadge origin="SIMULATED" /> : null}
      </div>
      {live.status === 'reconnecting' ? (
        <p className={styles.muted}>Ponowne łączenie — wartości mogą być nieaktualne.</p>
      ) : null}
      <table className={styles.values}>
        <caption className="visually-hidden">Bieżące wartości urządzenia {device.name}</caption>
        <thead>
          <tr>
            <th scope="col">Parametr</th>
            <th scope="col">Wartość</th>
            <th scope="col">Wiek</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ metric, value }) => (
            <tr key={metricId(metric)} className={value?.kind === 'value' && value.stale ? styles.staleRow : undefined}>
              <th scope="row">{metricLabel(metric)}</th>
              <td>{value?.kind === 'value' ? formatValue(value.value, metric.unit) : MISSING}</td>
              <td>
                {value === null || value.ageSeconds === null
                  ? 'brak odczytu'
                  : `${formatAge(value.ageSeconds)} temu${value.kind === 'value' && value.stale ? ' · nieaktualne' : ''}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

interface ChartData {
  history: History
  range: { from: Date; to: Date }
}

/** Mały wykres wybranej metryki za 24 h / 7 / 30 dni z API historii (D47); luki to przerwy. */
function DeviceChart({
  device,
  siteId,
  timeZone,
  historyUrl,
  onExpired,
  fetchFn,
}: {
  device: ApiDevice
  siteId: string
  timeZone: string
  historyUrl: string
  onExpired: () => void
  fetchFn: typeof fetch
}) {
  const id = useId()
  const metrics = chartMetrics(device)
  const [chosen, setChosen] = useState<string>('')
  const [span, setSpan] = useState<ChartSpan>('24h')
  const metric: ApiDeviceMetric | undefined = metrics.find((m) => metricId(m) === chosen) ?? metrics[0]
  const key = metric ? `${siteId}|${device.id}|${metricId(metric)}|${span}` : `${device.id}|none`
  const { state, reload } = usePeriodic<ChartData | null>(
    key,
    async (now, signal) => {
      if (!metric) return null
      const range = spanRange(span, now)
      const result = await getHistory(
        siteId,
        device.id,
        { metric: metric.key, channel: metric.channel, ...range },
        fetchFn,
        signal,
      )
      if (result.kind === 'anonymous') {
        onExpired()
        throw new SessionExpired()
      }
      if (result.kind !== 'ok') throw new Error('history')
      return { history: result.data, range }
    },
    DEVICE_CHART_REFRESH_MS,
  )

  const title = (
    <div className={styles.subHeader}>
      <h3 className={styles.subTitle}>Wykres</h3>
      <a href={historyUrl}>Pełna historia</a>
    </div>
  )
  if (!metric) {
    return (
      <div>
        {title}
        <p className={styles.muted}>Brak pomiarów chwilowych do wykresu.</p>
      </div>
    )
  }
  const label = `${metricLabel(metric)} — ${CHART_SPANS.find((s) => s.id === span)?.label ?? ''}`
  return (
    <div>
      {title}
      <div className={styles.chartControls}>
        {metrics.length > 1 ? (
          <div className={styles.field}>
            <label htmlFor={`${id}-metric`}>Parametr</label>
            <select id={`${id}-metric`} value={metricId(metric)} onChange={(e) => setChosen(e.target.value)}>
              {metrics.map((m) => (
                <option key={metricId(m)} value={metricId(m)}>
                  {metricLabel(m)}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className={styles.spans} role="group" aria-label="Zakres wykresu">
          {CHART_SPANS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={s.id === span ? `${styles.span} ${styles.spanActive}` : styles.span}
              aria-pressed={s.id === span}
              onClick={() => setSpan(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
      {state.status === 'loading' ? (
        <WidgetState status={{ kind: 'loading' }} />
      ) : state.status === 'error' ? (
        <WidgetState status={{ kind: 'error', onRetry: reload }} />
      ) : state.data === null || !hasValues(state.data.history) ? (
        <WidgetState status={{ kind: 'empty', message: 'Brak pomiarów w tym zakresie.' }} />
      ) : (
        <>
          {state.data.history.origins.includes('SIMULATED') ? <DemoBadge origin="SIMULATED" /> : null}
          <Suspense fallback={<WidgetState status={{ kind: 'loading' }} />}>
            <HistoryChartView
              history={state.data.history}
              timeZone={timeZone}
              range={state.data.range}
              label={`Wykres: ${label}`}
            />
          </Suspense>
        </>
      )}
    </div>
  )
}
