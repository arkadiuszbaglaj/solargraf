import { lazy, Suspense } from 'react'
import { Home, Leaf } from 'lucide-react'
import type { ApiDevice } from '../api/devices'
import type { Energy } from '../api/energy'
import { getEnergy } from '../api/energy'
import { DemoBadge } from '../components/DemoBadge'
import { ENERGY_LABEL, formatKwh, kpiText } from '../components/energyBarsOption'
import { KpiCard } from '../components/KpiCard'
import { Panel } from '../components/Panel'
import { WidgetState } from '../components/WidgetState'
import { useAsync } from '../hooks/useAsync'
import type { HistoryRange } from '../lib/historyRange'
import styles from './DeviceHistoryPage.module.css'

const EnergyBarsView = lazy(() => import('../components/EnergyBarsView').then((m) => ({ default: m.EnergyBarsView })))

/** Metryki, z których API liczy energię (D48): liczniki i moc zużycia. */
const ENERGY_METRICS: ReadonlySet<string> = new Set([
  'pv_energy_total',
  'grid_import_energy_total',
  'grid_export_energy_total',
  'battery_charge_energy_total',
  'battery_discharge_energy_total',
  'load_power',
])

export function hasEnergySources(device: ApiDevice): boolean {
  return device.metrics.some((m) => ENERGY_METRICS.has(m.key))
}

class SessionExpired extends Error {}

export function DeviceEnergyPanel({
  siteId,
  device,
  range,
  timeZone,
  fetchFn,
  onExpired,
}: {
  siteId: string
  device: ApiDevice
  range: HistoryRange
  timeZone: string
  fetchFn: typeof fetch
  onExpired: () => void
}) {
  const { state, reload } = useAsync<Energy | null>(
    async (signal) => {
      const result = await getEnergy(siteId, device.id, range, fetchFn, signal)
      if (result.kind === 'anonymous') {
        onExpired()
        throw new SessionExpired()
      }
      if (result.kind === 'not-found') return null
      if (result.kind === 'error') throw new Error('energy')
      return result.data
    },
    [siteId, device.id, range, fetchFn],
  )

  const origins = state.status === 'ready' && state.data ? state.data.origins : []
  const hasData = state.status === 'ready' && state.data?.series.some((s) => s.totalWh !== null)

  return (
    <Panel
      title="Energia i wskaźniki"
      actions={
        <span className={styles.badges}>
          {origins.includes('DEMO') ? <DemoBadge origin="DEMO" /> : null}
          {origins.includes('SIMULATED') ? <DemoBadge origin="SIMULATED" /> : null}
        </span>
      }
    >
      <WidgetState
        status={
          state.status === 'loading'
            ? { kind: 'loading' }
            : state.status === 'error'
              ? { kind: 'error', onRetry: reload }
              : state.data === null
                ? { kind: 'empty', message: 'Nie znaleziono urządzenia.' }
                : { kind: 'ready' }
        }
      >
        {state.status === 'ready' && state.data ? (
          <EnergyContent energy={state.data} range={range} timeZone={timeZone} hasData={Boolean(hasData)} />
        ) : null}
      </WidgetState>
    </Panel>
  )
}

function EnergyContent({
  energy,
  range,
  timeZone,
  hasData,
}: {
  energy: Energy
  range: HistoryRange
  timeZone: string
  hasData: boolean
}) {
  const sc = kpiText(energy.kpis.selfConsumption)
  const ss = kpiText(energy.kpis.selfSufficiency)
  return (
    <div className={styles.energy}>
      <div className={styles.kpis}>
        <KpiCard
          label="Autokonsumpcja"
          icon={Leaf}
          value={sc.value}
          notice={sc.note}
          secondary={`${energy.kpis.selfConsumption.definition}. Okres: ${range.label}.`}
          stale={false}
        />
        <KpiCard
          label="Samowystarczalność"
          icon={Home}
          value={ss.value}
          notice={ss.note}
          secondary={`${energy.kpis.selfSufficiency.definition}. Okres: ${range.label}.`}
          stale={false}
        />
      </div>
      {energy.series.length === 0 ? (
        <p className={styles.muted}>Urządzenie nie dostarcza pomiarów energii.</p>
      ) : (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className="visually-hidden">Energia w okresie {range.label}</caption>
              <thead>
                <tr>
                  <th scope="col">Energia</th>
                  <th scope="col">Suma</th>
                  <th scope="col">Pokrycie danymi</th>
                  <th scope="col">Uwagi</th>
                </tr>
              </thead>
              <tbody>
                {energy.series.map((s) => (
                  <tr key={s.key}>
                    <th scope="row">{ENERGY_LABEL[s.key]}</th>
                    <td>{formatKwh(s.totalWh)}</td>
                    <td>{Math.round(s.coverage * 100)}%</td>
                    <td>
                      {[
                        s.source === 'POWER' ? 'wyliczone z mocy' : null,
                        s.resetDetected ? 'wykryto reset licznika' : null,
                      ]
                        .filter(Boolean)
                        .join('; ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {hasData ? (
            <>
              <Suspense fallback={<WidgetState status={{ kind: 'loading' }} />}>
                <EnergyBarsView
                  energy={energy}
                  timeZone={timeZone}
                  label={`Wykres słupkowy energii w kWh, ${range.label}.`}
                />
              </Suspense>
              <p className="visually-hidden">Brak słupka oznacza brak danych, a nie zerową energię.</p>
            </>
          ) : (
            <WidgetState status={{ kind: 'empty', message: 'Brak danych o energii w tym okresie.' }} />
          )}
        </>
      )}
    </div>
  )
}
