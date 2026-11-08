import type { ReactNode } from 'react'
import { assignLocation, loginUrl } from '../api/auth'
import type { ComponentState, HealthLevel, SystemHealth } from '../api/system'
import { getSystemHealth } from '../api/system'
import { Panel } from '../components/Panel'
import { WidgetState } from '../components/WidgetState'
import { usePeriodic } from '../hooks/usePeriodic'
import { MISSING, formatBytes, formatDateTime, formatNumber, formatQuantity, formatUptime } from '../lib/format'
import styles from './ServerHealthPage.module.css'
import { ServerHistory } from './ServerHistory'
import { SystemAlarmsPanel } from './SystemAlarmsPanel'

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
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** Brak pomiaru pokazujemy słowem, żeby nie wyglądał jak wartość. */
const shown = (text: string): string => (text === MISSING ? UNAVAILABLE : text)

const ofTotal = (used: number | null, total: number | null): string =>
  total === null ? 'rozmiar niedostępny' : `${formatBytes(used)} z ${formatBytes(total)}`

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

/** Progi ostrzeżenia i stanu krytycznego z D60 — kolor paska jest tylko dodatkiem do liczby. */
type Tone = 'ok' | 'warning' | 'critical' | 'none'

function tone(value: number | null, warning: number, critical?: number): Tone {
  if (value === null) return 'none'
  if (critical !== undefined && value > critical) return 'critical'
  return value > warning ? 'warning' : 'ok'
}

/** Kafel zużycia: duża wartość, pasek (dekoracyjny) i opis. Brak pomiaru — „niedostępne”. */
function UsageTile({
  label,
  value,
  unit,
  state,
  detail,
}: {
  label: string
  value: number | null
  unit: '%' | '°C'
  state: Tone
  detail: string
}) {
  const text = value === null ? UNAVAILABLE : formatQuantity(value, unit)
  const fill = value === null ? null : Math.min(100, Math.max(0, value))
  return (
    <article className={styles.tile}>
      <h3 className={styles.tileLabel}>{label}</h3>
      <p className={`${styles.tileValue} ${value === null ? styles.unavailable : ''}`}>{text}</p>
      <div className={styles.bar} aria-hidden="true">
        {fill === null ? null : <span className={`${styles.barFill} ${styles[`tone_${state}`]}`} style={{ width: `${fill}%` }} />}
      </div>
      <p className={styles.tileDetail}>{detail}</p>
    </article>
  )
}

function HealthView({
  health,
  failed,
  timeZone,
  alarms,
}: {
  health: SystemHealth
  failed: boolean
  timeZone: string
  /** Panel alarmów serwera — obok oceny (na wąskim ekranie pod nią). */
  alarms: ReactNode
}) {
  const m = health.metrics
  const time = (iso: string | null): string => (iso === null ? MISSING : formatDateTime(iso, timeZone))
  const staleNotice = health.stale
    ? 'Ocena jest nieaktualna — usługa obliczeń (worker) nie zapisała nowej oceny. Poniższe wartości mogą być stare.'
    : failed
      ? 'Nie udało się odświeżyć danych. Pokazujemy ostatnie pobrane wartości.'
      : null
  const load =
    m.load_1m === null && m.load_5m === null && m.load_15m === null
      ? UNAVAILABLE
      : [m.load_1m, m.load_5m, m.load_15m].map((v) => formatNumber(v, 2)).join(' / ')

  return (
    <WidgetState status={{ kind: 'ready' }} staleNotice={staleNotice}>
      <div className={styles.columns}>
        <Panel title="Ocena stabilności">
          <p className={styles.level}>
            <span className={`${styles.badge} ${styles[health.level]}`}>
              <span className={styles.dot} aria-hidden="true" />
              {LEVEL_LABEL[health.level]}
            </span>
            <span className={styles.muted}>
              Ocena: {time(health.evaluatedAt)} · pomiar: {time(health.sampledAt)} · wersja {health.appVersion}
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
        {alarms}
      </div>

      <section className={styles.tiles} aria-label="Bieżące zużycie zasobów">
        <UsageTile
          label="Procesor"
          value={m.cpu_percent}
          unit="%"
          state={tone(m.cpu_percent, 85)}
          detail={`Obciążenie: ${load}`}
        />
        <UsageTile
          label="Pamięć RAM"
          value={health.percent.memory}
          unit="%"
          state={tone(health.percent.memory, 90)}
          detail={ofTotal(m.mem_used_bytes, m.mem_total_bytes)}
        />
        <UsageTile
          label="Dysk"
          value={health.percent.disk}
          unit="%"
          state={tone(health.percent.disk, 85, 95)}
          detail={ofTotal(m.disk_used_bytes, m.disk_total_bytes)}
        />
        <UsageTile
          label="Temperatura procesora"
          value={m.cpu_temp_c}
          unit="°C"
          state={tone(m.cpu_temp_c, 75)}
          detail={m.cpu_temp_c === null ? 'brak czujnika' : 'ostrzeżenie powyżej 75 °C'}
        />
      </section>

      <div className={styles.columns}>
        <Panel title="Składniki">
          <ul className={styles.components} aria-label="Stan składników">
            {health.components.map((c) => (
              <li key={c.component} className={styles.component}>
                <span className={styles.componentName}>{c.name}</span>
                <span className={`${styles.badge} ${styles[c.state]}`}>
                  <span className={styles.dot} aria-hidden="true" />
                  {STATE_LABEL[c.state]}
                </span>
                <span className={styles.componentMeta}>
                  {c.state === 'UP' ? `sprawdzony ${time(c.checkedAt)}` : `ostatnio działał: ${time(c.lastOkAt)}`}
                </span>
              </li>
            ))}
          </ul>
          {health.components.length === 0 ? <p className={styles.muted}>Brak wyników sprawdzania składników.</p> : null}
        </Panel>

        <Panel title="Szczegóły systemu">
          <dl className={styles.list}>
            <Row label="Rdzenie" value={shown(formatNumber(m.cpu_count, 0))} />
            <Row label="Obciążenie (1 / 5 / 15 min)" value={load} />
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
            <Row label="Rozmiar bazy danych" value={shown(formatBytes(m.db_size_bytes))} />
            <Row label="Niedobór napięcia" value={undervoltageText(m.undervoltage_now)} />
            <Row label="Czas pracy hosta" value={shown(formatUptime(m.uptime_s))} />
            <Row label="Czas serwera" value={time(health.serverTime)} />
          </dl>
        </Panel>
      </div>
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
      <HealthView
        health={state.data.data}
        failed={state.failed}
        timeZone={timeZone}
        alarms={<SystemAlarmsPanel fetchFn={fetchFn} onExpired={() => navigate(loginUrl('expired'))} timeZone={timeZone} />}
      />
      <ServerHistory fetchFn={fetchFn} onExpired={() => navigate(loginUrl('expired'))} timeZone={timeZone} />
    </div>
  )
}
