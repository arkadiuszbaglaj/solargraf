import { BatteryCharging, Home, Leaf, Sun, UtilityPole } from 'lucide-react'
import { KpiCard } from '../components/KpiCard'
import { WidgetState } from '../components/WidgetState'
import { useDataSource } from '../data/DataSourceContext'
import type { DashboardKpis, Measurement } from '../data/types'
import { useAsync } from '../hooks/useAsync'
import { formatAge, formatDirectedPower, formatQuantity, MISSING } from '../lib/format'
import { ageSeconds, isStale } from '../lib/freshness'
import styles from './KpiRow.module.css'

function unavailable(m: Measurement): string | null {
  return m.value === null ? 'Brak danych' : null
}

function today(m: Measurement): string {
  return `Dziś: ${formatQuantity(m.value, m.unit)}`
}

export function KpiCards({ kpis, now }: { kpis: DashboardKpis; now: Date }) {
  const stale = (m: Measurement): boolean => isStale(m, now, kpis.staleAfterSeconds)
  const grid = formatDirectedPower(kpis.gridPower.value, 'pobór z sieci', 'oddawanie do sieci')
  const battery = formatDirectedPower(kpis.batteryPower.value, 'rozładowanie', 'ładowanie')
  const selfUse = kpis.todaySelfConsumption
  const importToday = formatQuantity(kpis.todayGridImportEnergy.value, 'Wh')
  const exportToday = formatQuantity(kpis.todayGridExportEnergy.value, 'Wh')
  return (
    <div className={styles.row}>
      <KpiCard
        label="Produkcja PV"
        icon={Sun}
        value={formatQuantity(kpis.pvPower.value, 'W')}
        unavailableReason={unavailable(kpis.pvPower)}
        secondary={today(kpis.todayPvEnergy)}
        stale={stale(kpis.pvPower)}
      />
      <KpiCard
        label="Zużycie domu"
        icon={Home}
        value={formatQuantity(kpis.homePower.value, 'W')}
        unavailableReason={unavailable(kpis.homePower)}
        secondary={today(kpis.todayHomeEnergy)}
        stale={stale(kpis.homePower)}
      />
      <KpiCard
        label="Sieć"
        icon={UtilityPole}
        value={grid.text}
        detail={grid.direction}
        unavailableReason={unavailable(kpis.gridPower)}
        secondary={`Dziś: pobór ${importToday}, oddanie ${exportToday}`}
        stale={stale(kpis.gridPower)}
      />
      <KpiCard
        label="Magazyn energii"
        icon={BatteryCharging}
        value={formatQuantity(kpis.batterySoc.value, '%')}
        detail={battery.direction}
        unavailableReason={unavailable(kpis.batterySoc)}
        secondary={battery.text === MISSING ? null : `Moc: ${battery.text}`}
        stale={stale(kpis.batterySoc)}
      />
      <KpiCard
        label="Autokonsumpcja"
        icon={Leaf}
        value={formatQuantity(selfUse.value, '%')}
        unavailableReason={selfUse.value === null ? 'Brak produkcji PV dziś' : null}
        secondary="Dziś: (produkcja PV − oddanie) / produkcja PV"
        stale={stale(selfUse)}
      />
    </div>
  )
}

export function KpiRow({ siteId, now }: { siteId: string; now: Date }) {
  const source = useDataSource()
  const { state, reload } = useAsync((signal) => source.getKpis(siteId, signal), [source, siteId])

  if (state.status !== 'ready') {
    return (
      <section aria-label="Wskaźniki bieżące" className={styles.placeholder}>
        <WidgetState
          status={state.status === 'loading' ? { kind: 'loading' } : { kind: 'error', onRetry: reload }}
        />
      </section>
    )
  }
  const kpis = state.data
  const age = ageSeconds(kpis.pvPower.observedAt, now)
  const staleNotice = isStale(kpis.pvPower, now, kpis.staleAfterSeconds)
    ? `Dane nieaktualne — ostatni odczyt ${age === null ? 'nieznany' : `${formatAge(age)} temu`}.`
    : null
  return (
    <section aria-label="Wskaźniki bieżące">
      <WidgetState status={{ kind: 'ready' }} staleNotice={staleNotice}>
        <KpiCards kpis={kpis} now={now} />
      </WidgetState>
    </section>
  )
}
