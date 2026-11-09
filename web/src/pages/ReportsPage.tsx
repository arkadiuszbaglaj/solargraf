import { BatteryCharging, Download, Home, Leaf, Printer, ShieldCheck, Sun, UtilityPole } from 'lucide-react'
import { useState } from 'react'
import type { EnergyKey } from '../api/energy'
import { getEnergyReport, reportCsvUrl, type EnergyReport, type ReportResult, type ReportSelection } from '../api/reports'
import { DemoBadge } from '../components/DemoBadge'
import { EnergyBarsView } from '../components/EnergyBarsView'
import { formatKwh, kpiText } from '../components/energyBarsOption'
import { KpiCard } from '../components/KpiCard'
import { Panel } from '../components/Panel'
import { PeriodControls, type PeriodOption } from '../components/PeriodControls'
import { WidgetState } from '../components/WidgetState'
import type { Origin, Site } from '../data/types'
import { useAsync } from '../hooks/useAsync'
import { MISSING, wattHoursToKilowattHours } from '../lib/format'
import { bucketLabel, isCurrentOrLater, localYearMonth, periodLabel, shift } from './reportPeriod'
import styles from './ReportsPage.module.css'

const browserFetch: typeof fetch = (...args) => fetch(...args)

type Kind = 'month' | 'year'

const KINDS: Array<PeriodOption<Kind>> = [
  { value: 'month', label: 'Miesiąc' },
  { value: 'year', label: 'Rok' },
]

/** Kolumny tabeli w stałej kolejności (jak CSV z serwera). */
export const REPORT_COLUMNS: ReadonlyArray<{ key: EnergyKey; label: string }> = [
  { key: 'pv', label: 'Produkcja PV' },
  { key: 'load', label: 'Zużycie domu' },
  { key: 'grid_import', label: 'Pobór z sieci' },
  { key: 'grid_export', label: 'Oddanie do sieci' },
  { key: 'battery_charge', label: 'Ładowanie magazynu' },
  { key: 'battery_discharge', label: 'Rozładowanie magazynu' },
]

const KWH = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

/** kWh bez jednostki do komórki tabeli; brak danych to „—”, nigdy 0. */
export function kwhCell(wh: number | null): string {
  return wh === null ? MISSING : KWH.format(wattHoursToKilowattHours(wh))
}

/** Okres po zmianie rodzaju: rok wybranego roku albo miesiąc (bieżący, gdy to bieżący rok). */
function switchKind(kind: Kind, selection: ReportSelection, now: { year: number; month: number }): ReportSelection {
  if (kind === 'year') return { year: selection.year, month: null }
  if (selection.month !== null) return selection
  return selection.year === now.year ? now : { year: selection.year, month: 12 }
}

/**
 * Strona „Raporty” (D74): bilans energii instalacji za miesiąc (dni) albo rok (miesiące), wskaźniki
 * D27, wykres, tabela, CSV i wydruk. Tylko OWNER/ADMIN — serwer zwraca 403 pozostałym.
 */
export function ReportsPage({
  site,
  now,
  origin,
  fetchFn = browserFetch,
}: {
  site: Site
  now: Date
  /** W trybie DEMO raporty z serwera nie istnieją. */
  origin: Origin
  fetchFn?: typeof fetch
}) {
  if (origin === 'DEMO') {
    return (
      <Panel title="Raporty" actions={<DemoBadge origin="DEMO" />}>
        <WidgetState status={{ kind: 'empty', message: 'Raporty wymagają serwera — niedostępne w trybie DEMO.' }} />
      </Panel>
    )
  }
  return <Reports site={site} now={now} fetchFn={fetchFn} />
}

function Reports({ site, now, fetchFn }: { site: Site; now: Date; fetchFn: typeof fetch }) {
  const tz = site.timezone
  const [selection, setSelection] = useState<ReportSelection>(() => localYearMonth(now, tz))
  const { state, reload } = useAsync<ReportResult>(
    (signal) => getEnergyReport(site.id, selection, fetchFn, signal),
    [site.id, selection.year, selection.month, fetchFn],
  )

  const today = localYearMonth(now, tz)
  const kind: Kind = selection.month === null ? 'year' : 'month'
  const atCurrent = isCurrentOrLater(selection, now, tz)
  const result = state.status === 'ready' ? state.data : null
  const report = result?.kind === 'ok' ? result.data : null

  let body
  if (state.status === 'loading') body = <WidgetState status={{ kind: 'loading' }} />
  else if (result?.kind === 'ok') body = <ReportView report={result.data} timeZone={tz} />
  else if (result?.kind === 'forbidden')
    body = (
      <WidgetState
        status={{ kind: 'empty', message: 'Raporty są dostępne dla właściciela i administratora instalacji.' }}
      />
    )
  else if (result?.kind === 'error' && result.message)
    body = <WidgetState status={{ kind: 'empty', message: result.message }} />
  else body = <WidgetState status={{ kind: 'error', onRetry: reload }} />

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <div className={styles.controls}>
          <PeriodControls
            options={KINDS}
            value={kind}
            onChange={(k) => setSelection(switchKind(k, selection, today))}
            nav={{
              onPrev: () => setSelection(shift(selection, -1)),
              onToday: () => setSelection(kind === 'year' ? { year: today.year, month: null } : today),
              onNext: () => setSelection(shift(selection, 1)),
              isCurrent: atCurrent,
              nextDisabled: atCurrent,
            }}
          />
        </div>
        <h2 className={styles.period}>
          Raport: {periodLabel(selection)}
          <span className={styles.siteName}>{site.name}</span>
        </h2>
        <div className={styles.actions}>
          {report ? (
            <a className={styles.action} href={reportCsvUrl(site.id, selection)} download>
              <Download size={16} aria-hidden="true" />
              Pobierz CSV
            </a>
          ) : null}
          <button type="button" className={styles.action} onClick={() => window.print()} disabled={!report}>
            <Printer size={16} aria-hidden="true" />
            Drukuj / PDF
          </button>
        </div>
      </div>
      {body}
    </div>
  )
}

function ReportView({ report, timeZone }: { report: EnergyReport; timeZone: string }) {
  const series = new Map(report.series.map((s) => [s.key, s]))
  const columns = REPORT_COLUMNS.filter((c) => series.has(c.key))
  const total = (key: EnergyKey) => formatKwh(series.get(key)?.totalWh ?? null)
  const unavailable = (key: EnergyKey) =>
    report.unavailable.some((u) => u.key === key) ? 'Niedostępne w tej instalacji' : null
  const selfConsumption = kpiText(report.kpis.selfConsumption)
  const selfSufficiency = kpiText(report.kpis.selfSufficiency)
  const first = columns[0]
  const rows = first ? (series.get(first.key)?.buckets ?? []) : []
  const partial = report.series.some((s) => s.buckets.some((b) => b.wh !== null && b.coverage < 1))
  const missing = REPORT_COLUMNS.filter((c) => report.unavailable.some((u) => u.key === c.key))
  const loadFromPower = series.get('load')?.source === 'POWER'
  const simulated = report.origins.includes('SIMULATED')
  const demo = report.origins.includes('DEMO')

  return (
    <>
      {simulated || demo ? (
        <p className={styles.origin}>
          {demo ? <DemoBadge origin="DEMO" /> : null}
          {simulated ? <DemoBadge origin="SIMULATED" /> : null}
          Raport zawiera dane symulowane — to nie są pomiary rzeczywistej instalacji.
        </p>
      ) : null}
      <section className={styles.summary} aria-label="Podsumowanie okresu">
        <KpiCard
          label="Produkcja PV"
          icon={Sun}
          value={total('pv')}
          unavailableReason={unavailable('pv')}
          stale={false}
        />
        <KpiCard
          label="Zużycie domu"
          icon={Home}
          value={total('load')}
          unavailableReason={unavailable('load')}
          secondary={loadFromPower ? 'Wyliczone z mocy' : null}
          stale={false}
        />
        <KpiCard
          label="Sieć"
          icon={UtilityPole}
          value={total('grid_import')}
          detail={unavailable('grid_import') ? null : 'pobór'}
          unavailableReason={unavailable('grid_import')}
          secondary={unavailable('grid_import') ? null : `Oddanie: ${total('grid_export')}`}
          stale={false}
        />
        <KpiCard
          label="Magazyn energii"
          icon={BatteryCharging}
          value={total('battery_charge')}
          detail={unavailable('battery_charge') ? null : 'ładowanie'}
          unavailableReason={unavailable('battery_charge')}
          secondary={unavailable('battery_charge') ? null : `Rozładowanie: ${total('battery_discharge')}`}
          stale={false}
        />
        <KpiCard
          label="Autokonsumpcja"
          icon={Leaf}
          value={selfConsumption.value}
          notice={selfConsumption.note}
          secondary="Część produkcji PV zużyta na miejscu"
          stale={false}
        />
        <KpiCard
          label="Samowystarczalność"
          icon={ShieldCheck}
          value={selfSufficiency.value}
          notice={selfSufficiency.note}
          secondary="Część zużycia pokryta bez poboru z sieci"
          stale={false}
        />
      </section>
      {columns.length === 0 ? (
        <Panel title="Bilans energii">
          <WidgetState status={{ kind: 'empty', message: 'Żadne urządzenie instalacji nie podaje energii.' }} />
        </Panel>
      ) : (
        <>
          <Panel title="Energia w okresie" className={styles.chartPanel ?? ''}>
            <EnergyBarsView energy={report} timeZone={timeZone} label={`Energia instalacji: ${periodLabel(report)}`} />
          </Panel>
          <Panel title={report.period === 'year' ? 'Bilans miesięczny' : 'Bilans dzienny'}>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption className="visually-hidden">Energia w kWh: {periodLabel(report)}</caption>
                <thead>
                  <tr>
                    <th scope="col">{report.period === 'year' ? 'Miesiąc' : 'Dzień'}</th>
                    {columns.map((c) => (
                      <th key={c.key} scope="col">
                        {c.label} <span className={styles.unit}>[kWh]</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={row.t}>
                      <th scope="row">{bucketLabel(row.t, report.bucket, timeZone)}</th>
                      {columns.map((c) => {
                        const b = series.get(c.key)?.buckets[i]
                        const incomplete = b !== undefined && b.wh !== null && b.coverage < 1
                        return (
                          <td key={c.key}>
                            {kwhCell(b?.wh ?? null)}
                            {incomplete ? <span title="Niepełne dane">*</span> : null}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">Razem</th>
                    {columns.map((c) => (
                      <td key={c.key}>{kwhCell(series.get(c.key)?.totalWh ?? null)}</td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
            <ul className={styles.notes}>
              <li>„{MISSING}” oznacza brak danych w przedziale (nie zero).</li>
              {partial ? <li>* Niepełne dane — w części przedziału brakuje odczytów.</li> : null}
              {loadFromPower ? <li>Zużycie domu wyliczone z mocy (brak licznika energii).</li> : null}
              {missing.length > 0 ? (
                <li>Niedostępne w tej instalacji: {missing.map((m) => m.label.toLowerCase()).join(', ')}.</li>
              ) : null}
              <li>Dni i miesiące w strefie czasowej instalacji ({timeZone}).</li>
            </ul>
          </Panel>
        </>
      )}
    </>
  )
}
