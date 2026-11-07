import { BatteryCharging, Home, Sun, UtilityPole, type LucideIcon } from 'lucide-react'
import type { LiveSourceFactory } from '../api/live'
import { DemoBadge } from '../components/DemoBadge'
import { KpiCard } from '../components/KpiCard'
import { WidgetState } from '../components/WidgetState'
import { useLiveSite } from '../hooks/useLiveSite'
import { useNow } from '../hooks/useNow'
import { formatAge, formatDirectedPower, formatQuantity, MISSING } from '../lib/format'
import { siteValue, type SiteValue } from '../lib/liveValues'
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

function PowerCard({ label, icon, v }: { label: string; icon: LucideIcon; v: SiteValue }) {
  return (
    <KpiCard
      label={label}
      icon={icon}
      value={formatQuantity(num(v), 'W')}
      unavailableReason={reason(v)}
      secondary={age(v)}
      stale={stale(v)}
    />
  )
}

/** Karty bieżących wartości instalacji ze strumienia SSE (D50); wiek każdej wartości. */
export function LiveKpiRow({
  siteId,
  now: fixedNow,
  sourceFactory,
}: {
  siteId: string
  now?: Date
  sourceFactory?: LiveSourceFactory
}) {
  const { state, retry } = useLiveSite(siteId, sourceFactory)
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
  const simulated = all.some((v) => v.kind === 'value' && v.origin === 'SIMULATED')
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
          <PowerCard label="Produkcja PV" icon={Sun} v={pv} />
          <PowerCard label="Zużycie domu" icon={Home} v={home} />
          <KpiCard
            label="Sieć"
            icon={UtilityPole}
            value={gridFlow.text}
            detail={gridFlow.direction}
            unavailableReason={reason(grid)}
            secondary={age(grid)}
            stale={stale(grid)}
          />
          <KpiCard
            label="Magazyn energii"
            icon={BatteryCharging}
            value={formatQuantity(num(soc), '%')}
            detail={batteryFlow.direction}
            unavailableReason={reason(soc)}
            secondary={
              [batteryFlow.text === MISSING ? null : `Moc: ${batteryFlow.text}`, age(soc)]
                .filter(Boolean)
                .join(' · ') || null
            }
            stale={stale(soc) || stale(batteryPower)}
          />
        </div>
      </WidgetState>
    </section>
  )
}
