import { lazy, Suspense, useId, useMemo, useState } from 'react'
import { assignLocation, loginUrl } from '../api/auth'
import type { ApiDevice, ApiDeviceMetric } from '../api/devices'
import { listDevices } from '../api/devices'
import type { History } from '../api/history'
import { getHistory } from '../api/history'
import type { ApiSite } from '../api/sites'
import { getSite } from '../api/sites'
import { DemoBadge } from '../components/DemoBadge'
import { CALENDAR_PERIODS, PeriodControls } from '../components/PeriodControls'
import { Panel } from '../components/Panel'
import { WidgetState } from '../components/WidgetState'
import { displayUnit, hasValues, RESOLUTION_LABEL } from '../components/historyChartOption'
import { useAsync } from '../hooks/useAsync'
import { type Period, rangeFor, shiftAnchor, today } from '../lib/historyRange'
import { DeviceCsvExport } from './DeviceCsvExport'
import { DeviceEnergyPanel, hasEnergySources } from './DeviceEnergyPanel'
import { devicesUrl } from '../paths'
import styles from './DeviceHistoryPage.module.css'

// ECharts ładowany osobno — nie blokuje pierwszego renderu strony.
const HistoryChartView = lazy(() =>
  import('../components/HistoryChartView').then((m) => ({ default: m.HistoryChartView })),
)

class SessionExpired extends Error {}

const metricId = (m: ApiDeviceMetric) => `${m.key}|${m.channel ?? ''}`
const metricLabel = (m: ApiDeviceMetric) => (m.channel === null ? m.name : `${m.name} ${m.channel}`)

interface PageData {
  site: ApiSite
  device: ApiDevice | null
}

export function DeviceHistoryPage({
  siteId,
  deviceId,
  now,
  fetchFn = fetch,
  navigate = assignLocation,
}: {
  siteId: string
  deviceId: string
  now: Date
  fetchFn?: typeof fetch
  navigate?: (url: string) => void
}) {
  const expired = () => {
    navigate(loginUrl('expired'))
    return new SessionExpired()
  }
  const { state, reload } = useAsync<PageData | null>(
    async (signal) => {
      const site = await getSite(siteId, fetchFn, signal)
      if (site.kind === 'anonymous') throw expired()
      if (site.kind === 'not-found') return null
      if (site.kind === 'error') throw new Error('site')
      const devices = await listDevices(siteId, fetchFn, signal)
      if (devices.kind === 'anonymous') throw expired()
      if (devices.kind === 'error') throw new Error('devices')
      return { site: site.site, device: devices.data.find((d) => d.id === deviceId) ?? null }
    },
    [siteId, deviceId, fetchFn, navigate],
  )

  if (state.status === 'loading') return <WidgetState status={{ kind: 'loading' }} />
  if (state.status === 'error') return <WidgetState status={{ kind: 'error', onRetry: reload }} />
  if (state.data === null) return <WidgetState status={{ kind: 'empty', message: 'Nie znaleziono instalacji.' }} />

  const { site, device } = state.data
  const back = devicesUrl(site.id, device?.id)
  return (
    <div className={styles.page}>
      <p>
        <a href={back}>← Urządzenia</a>
      </p>
      {device === null ? (
        <WidgetState status={{ kind: 'empty', message: 'Nie znaleziono urządzenia.' }} />
      ) : device.metrics.length === 0 ? (
        <Panel title={`Historia — ${device.name}`}>
          <WidgetState status={{ kind: 'empty', message: 'Profil urządzenia nie udostępnia pomiarów.' }} />
        </Panel>
      ) : (
        <HistoryPanel
          site={site}
          device={device}
          now={now}
          fetchFn={fetchFn}
          onExpired={() => navigate(loginUrl('expired'))}
        />
      )}
    </div>
  )
}

function HistoryPanel({
  site,
  device,
  now,
  fetchFn,
  onExpired,
}: {
  site: ApiSite
  device: ApiDevice
  now: Date
  fetchFn: typeof fetch
  onExpired: () => void
}) {
  const selectId = useId()
  const [selected, setSelected] = useState(() => metricId(device.metrics[0] as ApiDeviceMetric))
  const [period, setPeriod] = useState<Period>('day')
  const tz = site.timezone
  const todayDate = today(now, tz)
  const [anchor, setAnchor] = useState(todayDate)
  const metric = device.metrics.find((m) => metricId(m) === selected) ?? (device.metrics[0] as ApiDeviceMetric)
  const range = useMemo(() => rangeFor(anchor, period, tz), [anchor, period, tz])
  const isCurrent = range.from <= now && now < range.to

  const { state, reload } = useAsync<History | null>(
    async (signal) => {
      const result = await getHistory(
        site.id,
        device.id,
        { metric: metric.key, channel: metric.channel, from: range.from, to: range.to },
        fetchFn,
        signal,
      )
      if (result.kind === 'anonymous') {
        onExpired()
        throw new SessionExpired()
      }
      if (result.kind === 'not-found') return null
      if (result.kind === 'error') throw new Error('history')
      return result.data
    },
    [site.id, device.id, metric.key, metric.channel, range, fetchFn],
  )

  const unit = displayUnit(metric.unit).unit
  const origins = state.status === 'ready' && state.data ? state.data.origins : []
  return (
    <>
    <Panel
      title={`Historia — ${device.name}`}
      actions={
        <span className={styles.badges}>
          {origins.includes('DEMO') ? <DemoBadge origin="DEMO" /> : null}
          {origins.includes('SIMULATED') ? <DemoBadge origin="SIMULATED" /> : null}
        </span>
      }
    >
      <div className={styles.controls}>
        <div className={styles.field}>
          <label htmlFor={selectId}>Pomiar</label>
          <select id={selectId} value={metricId(metric)} onChange={(e) => setSelected(e.target.value)}>
            {device.metrics.map((m) => (
              <option key={metricId(m)} value={metricId(m)}>
                {metricLabel(m)}
                {displayUnit(m.unit).unit ? ` [${displayUnit(m.unit).unit}]` : ''}
              </option>
            ))}
          </select>
        </div>
        <PeriodControls
          options={CALENDAR_PERIODS}
          value={period}
          onChange={setPeriod}
          nav={{
            onPrev: () => setAnchor(shiftAnchor(anchor, period, -1)),
            onToday: () => setAnchor(todayDate),
            onNext: () => setAnchor(shiftAnchor(anchor, period, 1)),
            isCurrent,
            nextDisabled: range.to > now,
          }}
        />
      </div>
      <p className={styles.range} aria-live="polite">
        {range.label}
        {state.status === 'ready' && state.data ? (
          <span className={styles.muted}> · rozdzielczość: {RESOLUTION_LABEL[state.data.resolution]}</span>
        ) : null}
      </p>
      <WidgetState
        status={
          state.status === 'loading'
            ? { kind: 'loading' }
            : state.status === 'error'
              ? { kind: 'error', onRetry: reload }
              : state.data === null
                ? { kind: 'empty', message: 'Nie znaleziono urządzenia.' }
                : !hasValues(state.data)
                  ? { kind: 'empty', message: 'Brak danych w tym okresie.' }
                  : { kind: 'ready' }
        }
      >
        {state.status === 'ready' && state.data ? (
          <>
            <Suspense fallback={<WidgetState status={{ kind: 'loading' }} />}>
              <HistoryChartView
                history={state.data}
                timeZone={tz}
                range={range}
                label={`Wykres: ${metricLabel(metric)}${unit ? ` w ${unit}` : ''}, ${range.label}.`}
              />
            </Suspense>
            <p className="visually-hidden">
              Przerwy w linii wykresu oznaczają brak danych, a nie wartość zero.
            </p>
            {metric.cumulative ? (
              <p className={styles.muted}>Wartości to stan licznika na koniec przedziału, nie energia za przedział.</p>
            ) : null}
          </>
        ) : null}
      </WidgetState>
      <DeviceCsvExport
        siteId={site.id}
        deviceId={device.id}
        range={range}
        period={period}
        fetchFn={fetchFn}
        onExpired={onExpired}
      />
    </Panel>
    {hasEnergySources(device) ? (
      <DeviceEnergyPanel
        siteId={site.id}
        device={device}
        range={range}
        timeZone={tz}
        fetchFn={fetchFn}
        onExpired={onExpired}
      />
    ) : null}
    </>
  )
}
