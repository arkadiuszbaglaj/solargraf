import { lazy, Suspense } from 'react'
import { loginUrl } from '../api/auth'
import { type EnergyBucketSize, getSiteEnergy, type SiteEnergy } from '../api/energy'
import { DemoBadge } from '../components/DemoBadge'
import { ENERGY_LABEL, formatKwh } from '../components/energyBarsOption'
import { Panel } from '../components/Panel'
import { WidgetState, type WidgetStatus } from '../components/WidgetState'
import { useAsync } from '../hooks/useAsync'
import styles from './SiteEnergyPanel.module.css'

// ECharts ładowany osobno — nie blokuje pierwszego renderu strony.
const EnergyBarsView = lazy(() => import('../components/EnergyBarsView').then((m) => ({ default: m.EnergyBarsView })))

const TITLE: Record<EnergyBucketSize, string> = {
  '1h': 'Energia godzina po godzinie',
  '1d': 'Energia dzień po dniu',
  '1mo': 'Energia miesiąc po miesiącu',
}

class SessionExpired extends Error {}

/** Przedział ma pomiary, ale nie za cały czas — słupek może być zaniżony. */
export const hasPartialBuckets = (energy: SiteEnergy): boolean =>
  energy.series.some((s) => s.buckets.some((b) => b.wh !== null && b.coverage < 1))

const hasValues = (energy: SiteEnergy): boolean =>
  energy.series.some((s) => s.buckets.some((b) => b.wh !== null))

/**
 * Energia instalacji w oglądanym okresie (D48, D51): suma okresu i słupki w przedziałach
 * (godziny dnia, dni tygodnia/miesiąca, miesiące roku). Brak pomiaru to brak słupka, nie zero.
 */
export function SiteEnergyPanel({
  siteId,
  range,
  timeZone,
  fetchFn,
  navigate,
}: {
  siteId: string
  range: { from: Date; to: Date; label: string }
  timeZone: string
  fetchFn: typeof fetch
  navigate: (url: string) => void
}) {
  const { state, reload } = useAsync(
    async (signal) => {
      const result = await getSiteEnergy(siteId, range, fetchFn, signal)
      if (result.kind === 'anonymous') {
        navigate(loginUrl('expired'))
        throw new SessionExpired()
      }
      if (result.kind !== 'ok') throw new Error('Nie udało się pobrać energii.')
      return result.data
    },
    [siteId, range, fetchFn, navigate],
  )

  const data = state.status === 'ready' ? state.data : null
  let status: WidgetStatus
  if (state.status === 'loading') status = { kind: 'loading' }
  else if (state.status === 'error') status = { kind: 'error', onRetry: reload }
  else if (state.data.series.length === 0)
    status = { kind: 'empty', message: 'Urządzenia instalacji nie podają energii.' }
  else if (!hasValues(state.data)) status = { kind: 'empty', message: 'Brak danych w tym okresie.' }
  else status = { kind: 'ready' }

  const badges = data ? (
    <span className={styles.badges}>
      {data.origins.includes('DEMO') ? <DemoBadge origin="DEMO" /> : null}
      {data.origins.includes('SIMULATED') ? <DemoBadge origin="SIMULATED" /> : null}
    </span>
  ) : null

  return (
    <Panel title={data ? TITLE[data.bucket] : 'Energia w okresie'} actions={badges}>
      <WidgetState status={status}>
        {data ? (
          <>
            <ul className={styles.totals} aria-label={`Suma energii: ${range.label}`}>
              {data.series.map((s) => (
                <li key={s.key} className={styles.total}>
                  <span className={styles.totalLabel}>{ENERGY_LABEL[s.key]}</span>
                  <span className={styles.totalValue}>{formatKwh(s.totalWh)}</span>
                  {s.source === 'POWER' ? <span className={styles.note}>wyliczone z mocy</span> : null}
                  {s.totalWh !== null && s.coverage < 1 ? (
                    <span className={styles.note}>pokrycie danymi {Math.round(s.coverage * 100)}%</span>
                  ) : null}
                </li>
              ))}
            </ul>
            <Suspense fallback={<WidgetState status={{ kind: 'loading' }} />}>
              <EnergyBarsView
                energy={data}
                timeZone={timeZone}
                label={`Energia instalacji w kWh: ${data.series.map((s) => ENERGY_LABEL[s.key]).join(', ')}; ${range.label}.`}
              />
            </Suspense>
            {hasPartialBuckets(data) ? (
              <p className={styles.note}>
                Część przedziałów ma niepełne dane — ich słupki mogą być zaniżone. Brak słupka oznacza brak danych, a
                nie zero.
              </p>
            ) : (
              <p className="visually-hidden">Brak słupka oznacza brak danych, a nie zero.</p>
            )}
            {data.unavailable.length > 0 ? (
              <p className={styles.note}>
                Niedostępne:{' '}
                {data.unavailable
                  .map(
                    (u) =>
                      `${ENERGY_LABEL[u.key].toLowerCase()} — ${u.reason === 'AMBIGUOUS' ? 'wiele źródeł' : 'brak źródła'}`,
                  )
                  .join('; ')}
                .
              </p>
            ) : null}
          </>
        ) : null}
      </WidgetState>
    </Panel>
  )
}
