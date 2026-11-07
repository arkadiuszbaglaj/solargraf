import { BatteryCharging, Home, Leaf, Sun, UtilityPole, type LucideIcon } from 'lucide-react'
import { DemoBadge } from '../components/DemoBadge'
import { KpiCard } from '../components/KpiCard'
import { WidgetState } from '../components/WidgetState'
import type { LiveSite } from '../hooks/useLiveSite'
import { useNow } from '../hooks/useNow'
import { formatAge, formatDirectedPower, formatQuantity, MISSING } from '../lib/format'
import { siteValue, type SiteValue } from '../lib/liveValues'
import { kpiView, todayEnergy, type TodayState } from '../lib/today'
import styles from './KpiRow.module.css'

function reason(v: SiteValue): string | null {
  switch (v.kind) {
    case 'value':
      return null
    case 'no-data':
      return 'Brak danych'
    case 'not-provided':
      return 'Urządzenia instalacji nie podają tego parametru'
    case 'ambiguous':
      return `Wiele źródeł (${v.sources}) — wartość niedostępna`
  }
}

function age(v: SiteValue): string | null {
  if (v.kind === 'value' || (v.kind === 'no-data' && v.ageSeconds !== null)) {
    return `Odczyt ${formatAge(v.ageSeconds ?? 0)} temu`
  }
  return null
}

const num = (v: SiteValue): number | null => (v.kind === 'value' ? v.value : null)
const stale = (v: SiteValue): boolean => v.kind === 'value' && v.stale

function PowerCard({
  label,
  icon,
  v,
  today,
}: {
  label: string
  icon: LucideIcon
  v: SiteValue
  today: string
}) {
  return (
    <KpiCard
      label={label}
      icon={icon}
      value={formatQuantity(num(v), 'W')}
      unavailableReason={reason(v)}
      secondary={today}
      age={age(v)}
      stale={stale(v)}
    />
  )
}

function SelfConsumptionCard({ today }: { today: TodayState | undefined }) {
  const view =
    today?.status === 'ready'
      ? kpiView(today.data.kpis.selfConsumption)
      : { value: MISSING, unavailableReason: today?.status === 'error' ? 'Brak danych' : null, notice: null }
  return (
    <KpiCard
      label="Autokonsumpcja"
      icon={Leaf}
      value={view.value}
      unavailableReason={view.unavailableReason}
      notice={view.notice}
      secondary="Dziś: (produkcja PV − oddanie) / produkcja PV"
      stale={false}
    />
  )
}

/**
 * Karty bieżących wartości instalacji ze strumienia SSE (D50); wiek każdej wartości. Strumień
 * otwiera dashboard (`useLiveSite`) i dzieli go z diagramem przepływu (D54) — jedno połączenie.
 */
export function LiveKpiRow({
  live,
  now: fixedNow,
  today,
}: {
  live: LiveSite
  now?: Date
  /** Energia instalacji od północy (D51); brak — karty bez wierszy „Dziś”. */
  today?: TodayState
}) {
  const { state, retry } = live
  const tickingNow = useNow(1000)
  const now = fixedNow ?? tickingNow

  if (state.status === 'connecting' || state.status === 'error') {
    return (
      <section aria-label="Wskaźniki bieżące" className={styles.placeholder}>
        <WidgetState
          status={state.status === 'connecting' ? { kind: 'loading' } : { kind: 'error', onRetry: retry }}
        />
      </section>
    )
  }

  const value = (metric: string): SiteValue => siteValue(state.devices, state.readings, metric, now)
  const pv = value('pv_power')
  const home = value('load_power')
  const grid = value('grid_power')
  const soc = value('battery_soc')
  const batteryPower = value('battery_power')
  const all = [pv, home, grid, soc, batteryPower]
  const simulated =
    all.some((v) => v.kind === 'value' && v.origin === 'SIMULATED') ||
    (today?.status === 'ready' && today.data.origins.includes('SIMULATED'))
  // Konwencja znaku D39: sieć + pobór / − oddawanie; bateria + rozładowanie / − ładowanie.
  const gridFlow = formatDirectedPower(num(grid), 'pobór z sieci', 'oddawanie do sieci')
  const batteryFlow = formatDirectedPower(num(batteryPower), 'rozładowanie', 'ładowanie')
  const notice =
    state.status === 'reconnecting'
      ? 'Utracono połączenie z serwerem — ponawianie. Wartości mogą być nieaktualne.'
      : null

  return (
    <section aria-label="Wskaźniki bieżące">
      {simulated ? (
        <p className={styles.origin}>
          <DemoBadge origin="SIMULATED" /> Część wartości pochodzi z symulatora.
        </p>
      ) : null}
      <WidgetState status={{ kind: 'ready' }} staleNotice={notice}>
        <div className={styles.row}>
          <PowerCard label="Produkcja PV" icon={Sun} v={pv} today={`Dziś: ${todayEnergy(today, 'pv')}`} />
          <PowerCard
            label="Zużycie domu"
            icon={Home}
            v={home}
            today={`Dziś: ${todayEnergy(today, 'load')} (z mocy)`}
          />
          <KpiCard
            label="Sieć"
            icon={UtilityPole}
            value={gridFlow.text}
            detail={gridFlow.direction}
            unavailableReason={reason(grid)}
            secondary={`Dziś: pobór ${todayEnergy(today, 'grid_import')}, oddanie ${todayEnergy(today, 'grid_export')}`}
            age={age(grid)}
            stale={stale(grid)}
          />
          <KpiCard
            label="Magazyn energii"
            icon={BatteryCharging}
            value={formatQuantity(num(soc), '%')}
            detail={batteryFlow.direction}
            unavailableReason={reason(soc)}
            secondary={`Dziś: ładowanie ${todayEnergy(today, 'battery_charge')}, rozładowanie ${todayEnergy(today, 'battery_discharge')}`}
            age={[batteryFlow.text === MISSING ? null : `Moc: ${batteryFlow.text}`, age(soc)].filter(Boolean).join(' · ') || null}
            stale={stale(soc) || stale(batteryPower)}
          />
          <SelfConsumptionCard today={today} />
        </div>
      </WidgetState>
    </section>
  )
}
