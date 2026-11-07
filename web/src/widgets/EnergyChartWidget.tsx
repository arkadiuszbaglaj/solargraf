import { lazy, Suspense } from 'react'
import { Panel } from '../components/Panel'
import { WidgetState, type WidgetStatus } from '../components/WidgetState'
import { useDataSource } from '../data/DataSourceContext'
import { useAsync } from '../hooks/useAsync'

// ECharts ładowany osobno — nie blokuje pierwszego renderu dashboardu.
const EnergyChartView = lazy(() =>
  import('../components/EnergyChartView').then((m) => ({ default: m.EnergyChartView })),
)

export function EnergyChartWidget({ siteId, timeZone }: { siteId: string; timeZone: string }) {
  const source = useDataSource()
  const { state, reload } = useAsync(
    (signal) => source.getEnergyChart(siteId, signal),
    [source, siteId],
  )

  let status: WidgetStatus
  if (state.status === 'loading') status = { kind: 'loading' }
  else if (state.status === 'error') status = { kind: 'error', onRetry: reload }
  else if (!state.data.pv.some(([, v]) => v !== null))
    status = { kind: 'empty', message: 'Brak danych za ten dzień.' }
  else status = { kind: 'ready' }

  const date =
    state.status === 'ready'
      ? new Intl.DateTimeFormat('pl-PL', { dateStyle: 'long', timeZone: 'UTC' }).format(
          new Date(`${state.data.localDate}T00:00:00Z`),
        )
      : null

  return (
    <Panel title="Produkcja i zużycie energii" actions={date ? <span>{date}</span> : null}>
      <WidgetState status={status}>
        {state.status === 'ready' ? (
          <>
            <Suspense fallback={<WidgetState status={{ kind: 'loading' }} />}>
              <EnergyChartView
                chart={state.data}
                timeZone={timeZone}
                label={`Wykres mocy w ciągu dnia ${date ?? ''}: produkcja PV, zużycie domu i pobór z sieci w kW.`}
              />
            </Suspense>
            <p className="visually-hidden">
              Przerwy w liniach wykresu oznaczają brak danych, a nie zerową moc.
            </p>
          </>
        ) : null}
      </WidgetState>
    </Panel>
  )
}
