import { lazy, Suspense } from 'react'
import { listDevices } from '../api/devices'
import { getHistory, type History } from '../api/history'
import { DemoBadge } from '../components/DemoBadge'
import { Panel } from '../components/Panel'
import { WidgetState, type WidgetStatus } from '../components/WidgetState'
import type { EnergyChart, SeriesPoint } from '../data/types'
import { usePeriodic } from '../hooks/usePeriodic'
import { singleSource } from '../lib/liveValues'
import { localDate, startOfLocalDay } from '../lib/time'

const EnergyChartView = lazy(() =>
  import('../components/EnergyChartView').then((m) => ({ default: m.EnergyChartView })),
)

const LINES = [
  { metric: 'pv_power', name: 'produkcja PV' },
  { metric: 'load_power', name: 'zużycie domu' },
  { metric: 'grid_power', name: 'sieć' },
] as const

export interface TodayChart {
  chart: EnergyChart
  /** Linie bez jednego źródła (brak albo kilka urządzeń) — opis pod wykresem. */
  missing: string[]
  simulated: boolean
}

const points = (h: History | null): SeriesPoint[] =>
  h ? h.points.map((p): SeriesPoint => [p.t, p.value]) : []

/**
 * Moc dziś (D51): PV, zużycie domu i sieć od północy w strefie instalacji, przedziały 5 min
 * z API historii (D46). Każda linia z jednego urządzenia-źródła; luki to przerwy, nie zero.
 */
export async function loadTodayChart(
  siteId: string,
  timeZone: string,
  now: Date,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<TodayChart> {
  const devices = await listDevices(siteId, fetchFn, signal)
  if (devices.kind !== 'ok') throw new Error('Nie udało się pobrać urządzeń.')
  const from = startOfLocalDay(now, timeZone)
  const missing: string[] = []
  const histories = await Promise.all(
    LINES.map(async ({ metric, name }) => {
      const source = singleSource(devices.data, metric)
      if (source.kind !== 'one') {
        missing.push(source.kind === 'many' ? `${name} — wiele źródeł` : `${name} — brak źródła`)
        return null
      }
      const result = await getHistory(
        siteId,
        source.device.id,
        { metric, channel: null, from, to: now, resolution: '5m' },
        fetchFn,
        signal,
      )
      if (result.kind !== 'ok') throw new Error('Nie udało się pobrać historii.')
      return result.data
    }),
  )
  const [pv = null, home = null, grid = null] = histories
  return {
    chart: {
      origin: 'DEVICE',
      localDate: localDate(now, timeZone),
      unit: 'W',
      pv: points(pv),
      home: points(home),
      gridImport: points(grid),
      gridLabel: 'Sieć (+ pobór, − oddawanie)',
    },
    missing,
    simulated: histories.some((h) => h?.origins.includes('SIMULATED') ?? false),
  }
}

const browserFetch: typeof fetch = (...args) => fetch(...args)

const hasValues = (chart: EnergyChart): boolean =>
  [chart.pv, chart.home, chart.gridImport].some((s) => s.some(([, v]) => v !== null))

export function TodayPowerChart({
  siteId,
  timeZone,
  fetchFn = browserFetch,
}: {
  siteId: string
  timeZone: string
  fetchFn?: typeof fetch
}) {
  const { state, reload } = usePeriodic(`${siteId}|${timeZone}`, (now, signal) =>
    loadTodayChart(siteId, timeZone, now, fetchFn, signal),
  )

  let status: WidgetStatus
  if (state.status === 'loading') status = { kind: 'loading' }
  else if (state.status === 'error') status = { kind: 'error', onRetry: reload }
  else if (state.data.missing.length === LINES.length)
    status = { kind: 'empty', message: 'Urządzenia instalacji nie podają mocy PV, zużycia ani sieci.' }
  else if (!hasValues(state.data.chart)) status = { kind: 'empty', message: 'Brak danych od północy.' }
  else status = { kind: 'ready' }

  const ready = state.status === 'ready' ? state : null
  return (
    <Panel
      title="Produkcja i zużycie dziś"
      actions={ready?.data.simulated ? <DemoBadge origin="SIMULATED" /> : null}
    >
      <WidgetState
        status={status}
        staleNotice={ready?.failed ? 'Nie udało się odświeżyć — dane z poprzedniego pobrania.' : null}
      >
        {ready ? (
          <>
            <Suspense fallback={<WidgetState status={{ kind: 'loading' }} />}>
              <EnergyChartView
                chart={ready.data.chart}
                timeZone={timeZone}
                label="Wykres mocy od północy: produkcja PV, zużycie domu i sieć w kW (średnie 5 min)."
              />
            </Suspense>
            {ready.data.missing.length > 0 ? <p>Niedostępne: {ready.data.missing.join('; ')}.</p> : null}
            <p className="visually-hidden">Przerwy w liniach wykresu oznaczają brak danych, a nie zerową moc.</p>
          </>
        ) : null}
      </WidgetState>
    </Panel>
  )
}
