import { lazy, Suspense } from 'react'
import { getHistory, type History } from '../api/history'
import type { LiveDevice } from '../api/live'
import { WidgetState, type WidgetStatus } from '../components/WidgetState'
import { usePeriodic } from '../hooks/usePeriodic'
import { singleSource } from '../lib/liveValues'
import { startOfLocalDay } from '../lib/time'
import styles from './MpptChart.module.css'

const StringChartView = lazy(() =>
  import('../components/StringChartView').then((m) => ({ default: m.StringChartView })),
)

export interface MpptChartData {
  voltage: History | null
  current: History | null
  range: { from: Date; to: Date }
}

const METRICS = ['pv_string_voltage', 'pv_string_current'] as const

/**
 * Napięcie i prąd stringu od północy w strefie instalacji, przedziały 5 min z API historii (D46).
 * Każda seria z jednego urządzenia-źródła (D50); brak albo wiele źródeł — seria pominięta.
 */
export async function loadMpptChart(
  siteId: string,
  devices: readonly LiveDevice[],
  channel: number,
  timeZone: string,
  now: Date,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<MpptChartData> {
  const range = { from: startOfLocalDay(now, timeZone), to: now }
  const [voltage = null, current = null] = await Promise.all(
    METRICS.map(async (metric) => {
      const source = singleSource(devices, metric, channel)
      if (source.kind !== 'one') return null
      const result = await getHistory(
        siteId,
        source.device.id,
        { metric, channel, from: range.from, to: range.to, resolution: '5m' },
        fetchFn,
        signal,
      )
      if (result.kind !== 'ok') throw new Error('Nie udało się pobrać historii stringu.')
      return result.data
    }),
  )
  return { voltage, current, range }
}

const hasValues = (h: History | null): boolean => h?.points.some((p) => p.value !== null) ?? false

const browserFetch: typeof fetch = (...args) => fetch(...args)

/** Wykres V/A stringu MPPT (D69) pod wartościami bieżącymi stringu. */
export function MpptChart({
  siteId,
  devices,
  channel,
  timeZone,
  fetchFn = browserFetch,
}: {
  siteId: string
  devices: readonly LiveDevice[]
  channel: number
  timeZone: string
  fetchFn?: typeof fetch
}) {
  const deviceKey = devices.map((d) => `${d.id}:${d.enabled}`).join(',')
  const { state, reload } = usePeriodic(`${siteId}|${channel}|${timeZone}|${deviceKey}`, (now, signal) =>
    loadMpptChart(siteId, devices, channel, timeZone, now, fetchFn, signal),
  )

  let status: WidgetStatus
  if (state.status === 'loading') status = { kind: 'loading' }
  else if (state.status === 'error') status = { kind: 'error', onRetry: reload }
  else if (!hasValues(state.data.voltage) && !hasValues(state.data.current))
    status = { kind: 'empty', message: 'Brak danych napięcia i prądu stringu od północy.' }
  else status = { kind: 'ready' }

  const ready = state.status === 'ready' ? state.data : null
  const parts = [ready?.voltage ? 'napięcie w V (oś lewa)' : null, ready?.current ? 'prąd w A (oś prawa)' : null]
  return (
    <WidgetState status={status} staleNotice={state.status === 'ready' && state.failed ? 'Nie udało się odświeżyć wykresu.' : null}>
      {ready ? (
        <Suspense fallback={<WidgetState status={{ kind: 'loading' }} />}>
          <StringChartView
            voltage={ready.voltage}
            current={ready.current}
            timeZone={timeZone}
            range={ready.range}
            label={`Wykres MPPT ${channel} od północy: ${parts.filter(Boolean).join(' i ')}. Przerwy oznaczają brak danych.`}
          />
          <p className={styles.legend} aria-hidden="true">
            {ready.voltage ? <span className={styles.voltage}>Napięcie (V, oś lewa)</span> : null}
            {ready.current ? <span className={styles.current}>Prąd (A, oś prawa)</span> : null}
          </p>
        </Suspense>
      ) : null}
    </WidgetState>
  )
}
