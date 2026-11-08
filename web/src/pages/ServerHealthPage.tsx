import { assignLocation, loginUrl } from '../api/auth'
import type { ComponentState, HealthLevel, SystemHealth } from '../api/system'
import { getSystemHealth } from '../api/system'
import { Panel } from '../components/Panel'
import { WidgetState } from '../components/WidgetState'
import { usePeriodic } from '../hooks/usePeriodic'
import { MISSING, formatBytes, formatDateTime, formatNumber, formatQuantity, formatUptime } from '../lib/format'
import styles from './ServerHealthPage.module.css'
import { ServerHistory } from './ServerHistory'
import { UpdatesPanel } from './UpdatesPanel'

/** Pomiar w workerze jest co 60 s (D60) — częściej nie ma czego odświeżać. */
export const HEALTH_REFRESH_MS = 60_000

export const LEVEL_LABEL: Record<HealthLevel, string> = {
  STABLE: 'Stabilny',
  WARNING: 'Ostrzeżenie',
  CRITICAL: 'Krytyczny',
  UNKNOWN: 'Brak oceny',
}

export const STATE_LABEL: Record<ComponentState, string> = {
  UP: 'Działa',
  DOWN: 'Niedostępny',
  UNKNOWN: 'Nieznany',
}

const UNAVAILABLE = 'niedostępne'

class SessionExpired extends Error {}

type PageData = { kind: 'ok'; data: SystemHealth } | { kind: 'forbidden' }

/** Czas serwera prezentujemy w strefie przeglądarki — nie należy do żadnej instalacji. */
function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** Brak pomiaru pokazujemy słowem, żeby nie wyglądał jak wartość. */
const shown = (text: string): string => (text === MISSING ? UNAVAILABLE : text)
const percent = (value: number | null): string => shown(value === null ? MISSING : formatQuantity(value, '%'))

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.row}>
      <dt>{label}</dt>
      <dd className={value === UNAVAILABLE ? styles.unavailable : undefined}>{value}</dd>
    </div>
  )
}

function undervoltageText(flag: number | null): string {
  if (flag === null) return UNAVAILABLE
  return flag > 0 ? 'wykryty' : 'nie wykryto'
}

function HealthView({ health, failed, timeZone }: { health: SystemHealth; failed: boolean; timeZone: string }) {
  const m = health.metrics
  const time = (iso: string | null): string => (iso === null ? MISSING : formatDateTime(iso, timeZone))
  const staleNotice = health.stale
    ? 'Ocena jest nieaktualna — usługa obliczeń (worker) nie zapisała nowej oceny. Poniższe wartości mogą być stare.'
    : failed
      ? 'Nie udało się odświeżyć danych. Pokazujemy ostatnie pobrane wartości.'
      : null

  return (
    <WidgetState status={{ kind: 'ready' }} staleNotice={staleNotice}>
      <Panel title="Ocena stabilności">
        <p className={styles.level}>
          <span className={`${styles.badge} ${styles[health.level]}`}>
            <span className={styles.dot} aria-hidden="true" />
            {LEVEL_LABEL[health.level]}
          </span>
          <span className={styles.muted}>
            Ocena: {time(health.evaluatedAt)} · pomiar: {time(health.sampledAt)}
          </span>
        </p>
        {health.reasons.length === 0 ? (
          <p className={styles.muted}>
            {health.level === 'STABLE' ? 'Wszystkie wartości w normie.' : 'Brak szczegółów oceny.'}
          </p>
        ) : (
          <ul className={styles.reasons} aria-label="Przyczyny oceny">
            {health.reasons.map((r) => (
              <li key={r.code} className={styles[r.severity]}>
                <strong>{r.severity === 'CRITICAL' ? 'Krytyczne' : 'Ostrzeżenie'}:</strong> {r.message}
                {r.since ? <span className={styles.muted}> (od {time(r.since)})</span> : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className={styles.grid}>
        <Panel title="Procesor">
          <dl className={styles.list}>
            <Row label="Użycie" value={percent(m.cpu_percent)} />
            <Row
              label="Obciążenie (1 / 5 / 15 min)"
              value={
                m.load_1m === null && m.load_5m === null && m.load_15m === null
                  ? UNAVAILABLE
                  : [m.load_1m, m.load_5m, m.load_15m].map((v) => formatNumber(v, 2)).join(' / ')
              }
            />
            <Row label="Rdzenie" value={shown(formatNumber(m.cpu_count, 0))} />
          </dl>
        </Panel>

        <Panel title="Pamięć">
          <dl className={styles.list}>
            <Row label="RAM zajęty" value={percent(health.percent.memory)} />
            <Row
              label="RAM zajęty / całkowity"
              value={shown(
                m.mem_total_bytes === null ? MISSING : `${formatBytes(m.mem_used_bytes)} / ${formatBytes(m.mem_total_bytes)}`,
              )}
            />
            <Row
              label="Swap"
              value={
                m.swap_total_bytes === 0
                  ? 'wyłączony'
                  : shown(
                      m.swap_total_bytes === null
                        ? MISSING
                        : `${formatBytes(m.swap_used_bytes)} / ${formatBytes(m.swap_total_bytes)}`,
                    )
              }
            />
          </dl>
        </Panel>

        <Panel title="Dysk">
          <dl className={styles.list}>
            <Row label="Zajętość" value={percent(health.percent.disk)} />
            <Row
              label="Zajęty / całkowity"
              value={shown(
                m.disk_total_bytes === null
                  ? MISSING
                  : `${formatBytes(m.disk_used_bytes)} / ${formatBytes(m.disk_total_bytes)}`,
              )}
            />
            <Row label="Rozmiar bazy danych" value={shown(formatBytes(m.db_size_bytes))} />
          </dl>
        </Panel>

        <Panel title="Temperatura i zasilanie">
          <dl className={styles.list}>
            <Row label="Temperatura procesora" value={shown(formatQuantity(m.cpu_temp_c, '°C'))} />
            <Row label="Niedobór napięcia" value={undervoltageText(m.undervoltage_now)} />
          </dl>
        </Panel>

        <Panel title="System">
          <dl className={styles.list}>
            <Row label="Czas pracy hosta" value={shown(formatUptime(m.uptime_s))} />
            <Row label="Wersja aplikacji" value={health.appVersion} />
            <Row label="Czas serwera" value={time(health.serverTime)} />
          </dl>
        </Panel>
      </div>

      <Panel title="Składniki">
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Składnik</th>
                <th scope="col">Stan</th>
                <th scope="col">Ostatnie sprawdzenie</th>
                <th scope="col">Ostatnio działał</th>
              </tr>
            </thead>
            <tbody>
              {health.components.map((c) => (
                <tr key={c.component}>
                  <th scope="row">{c.name}</th>
                  <td>
                    <span className={`${styles.badge} ${styles[c.state]}`}>
                      <span className={styles.dot} aria-hidden="true" />
                      {STATE_LABEL[c.state]}
                    </span>
                  </td>
                  <td>{time(c.checkedAt)}</td>
                  <td>{time(c.lastOkAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {health.components.length === 0 ? <p className={styles.muted}>Brak wyników sprawdzania składników.</p> : null}
      </Panel>
    </WidgetState>
  )
}

/** Ustawienia → Stan serwera (D16, D60). Dostęp sprawdza serwer — tylko rola OWNER. */
export function ServerHealthPage({
  fetchFn = fetch,
  navigate = assignLocation,
  timeZone = browserTimeZone(),
}: {
  fetchFn?: typeof fetch
  navigate?: (url: string) => void
  timeZone?: string
}) {
  const { state, reload } = usePeriodic<PageData>(
    'server-health',
    async (_now, signal) => {
      const result = await getSystemHealth(fetchFn, signal)
      if (result.kind === 'anonymous') {
        navigate(loginUrl('expired'))
        throw new SessionExpired()
      }
      if (result.kind === 'error') throw new Error('health')
      return result
    },
    HEALTH_REFRESH_MS,
  )

  if (state.status === 'loading') return <WidgetState status={{ kind: 'loading' }} />
  if (state.status === 'error') return <WidgetState status={{ kind: 'error', onRetry: reload }} />
  if (state.data.kind === 'forbidden') {
    return (
      <WidgetState
        status={{ kind: 'empty', message: 'Stan serwera jest dostępny tylko dla właściciela organizacji (rola OWNER).' }}
      />
    )
  }
  return (
    <div className={styles.page}>
      <HealthView health={state.data.data} failed={state.failed} timeZone={timeZone} />
      <UpdatesPanel fetchFn={fetchFn} onExpired={() => navigate(loginUrl('expired'))} timeZone={timeZone} />
      <ServerHistory fetchFn={fetchFn} onExpired={() => navigate(loginUrl('expired'))} timeZone={timeZone} />
    </div>
  )
}
