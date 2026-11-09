import { getPollingStats, type PollingStats } from '../api/pollingStats'
import { WidgetState } from '../components/WidgetState'
import { usePeriodic } from '../hooks/usePeriodic'
import { MISSING, formatDateTime } from '../lib/format'
import styles from './DevicesPage.module.css'

/** Statystyka przebiegów zmienia się z każdym odczytem; minuta wystarcza. */
export const READ_QUALITY_REFRESH_MS = 60_000

class SessionExpired extends Error {}

const PERCENT = new Intl.NumberFormat('pl-PL', { style: 'percent', maximumFractionDigits: 1 })

/** Udział poprawnych parametrów; brak odczytów to „—”, nie 0 %. */
export function percentCell(ratio: number | null): string {
  return ratio === null ? MISSING : PERCENT.format(ratio)
}

const RESULT_LABEL = { PARTIAL: 'częściowy', FAILED: 'nieudany' } as const

/** Jakość odczytów urządzenia z ostatnich 24 h (D76): przebiegi, udział parametrów, ostatnie błędy. */
export function DeviceReadQuality({
  siteId,
  deviceId,
  timeZone,
  onExpired,
  fetchFn,
}: {
  siteId: string
  deviceId: string
  timeZone: string
  onExpired: () => void
  fetchFn: typeof fetch
}) {
  const { state, reload } = usePeriodic<PollingStats>(
    `${siteId}|${deviceId}|polling`,
    async (_now, signal) => {
      const result = await getPollingStats(siteId, deviceId, fetchFn, signal)
      if (result.kind === 'anonymous') {
        onExpired()
        throw new SessionExpired()
      }
      if (result.kind !== 'ok') throw new Error('polling-stats')
      return result.data
    },
    READ_QUALITY_REFRESH_MS,
  )
  const title = <h3 className={styles.subTitle}>Jakość odczytów (24 h)</h3>
  if (state.status === 'loading' || state.status === 'error') {
    return (
      <div>
        {title}
        <WidgetState status={state.status === 'loading' ? { kind: 'loading' } : { kind: 'error', onRetry: reload }} />
      </div>
    )
  }
  const s = state.data
  const runs = s.runsOk + s.runsPartial + s.runsFailed
  if (runs === 0) {
    return (
      <div>
        {title}
        <WidgetState status={{ kind: 'empty', message: 'Brak przebiegów odczytu w ostatnich 24 h.' }} />
      </div>
    )
  }
  return (
    <div>
      {title}
      <dl className={styles.facts}>
        <dt>Odczyty pełne</dt>
        <dd>{s.runsOk}</dd>
        <dt>Odczyty częściowe</dt>
        <dd>{s.runsPartial}</dd>
        <dt>Odczyty nieudane</dt>
        <dd>{s.runsFailed}</dd>
        <dt>Poprawne parametry</dt>
        <dd>
          {percentCell(s.pointsOkRatio)}
          {s.pointsOkRatio !== null ? (
            <span className={styles.muted}>
              {' '}
              ({s.okPoints} z {s.okPoints + s.failedPoints})
            </span>
          ) : null}
        </dd>
        <dt>Ostatni przebieg</dt>
        <dd>{s.lastRunAt ? formatDateTime(s.lastRunAt, timeZone) : MISSING}</dd>
      </dl>
      {state.failed ? <p className={styles.muted}>Nie udało się odświeżyć — dane mogą być nieaktualne.</p> : null}
      {s.recentErrors.length > 0 ? (
        <table className={`${styles.values} ${styles.errorsTable ?? ''}`}>
          <caption className={styles.captionLeft}>Ostatnie błędy</caption>
          <thead>
            <tr>
              <th scope="col">Czas</th>
              <th scope="col">Wynik</th>
              <th scope="col">Opis</th>
            </tr>
          </thead>
          <tbody>
            {s.recentErrors.map((e) => (
              <tr key={e.startedAt}>
                <th scope="row">{formatDateTime(e.startedAt, timeZone)}</th>
                <td>
                  {RESULT_LABEL[e.result]}
                  {e.failedPoints > 0 ? <span className={styles.muted}> · {e.failedPoints} param.</span> : null}
                </td>
                <td>{e.errorDetail ?? e.errorCode ?? 'Pominięte parametry.'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className={styles.muted}>Brak błędów odczytu w ostatnich 24 h.</p>
      )}
    </div>
  )
}
