import { listDevices, listSiteAgents, type ApiAgent, type ApiDevice, type DeviceStatus } from '../api/devices'
import { Panel } from '../components/Panel'
import { SupportLevelLabel } from '../components/SupportLevelLabel'
import { WidgetState, type WidgetStatus } from '../components/WidgetState'
import { useNow } from '../hooks/useNow'
import { usePeriodic } from '../hooks/usePeriodic'
import { AGENT_STATUS_LABEL, KIND_LABEL, STATUS_LABEL } from '../lib/deviceLabels'
import { formatAge } from '../lib/format'
import { ageSeconds } from '../lib/freshness'
import { devicesUrl } from '../paths'
import styles from './SiteDevicesPanel.module.css'

export const DEVICES_REFRESH_MS = 30_000

const PROBLEMS: ReadonlySet<DeviceStatus> = new Set(['ERROR', 'STALE', 'UNKNOWN'])

interface PanelData {
  devices: ApiDevice[]
  agents: ApiAgent[]
}

async function loadPanel(siteId: string, fetchFn: typeof fetch, signal: AbortSignal): Promise<PanelData> {
  const [devices, agents] = await Promise.all([
    listDevices(siteId, fetchFn, signal),
    listSiteAgents(siteId, fetchFn, signal),
  ])
  if (devices.kind !== 'ok' || agents.kind !== 'ok') throw new Error('Nie udało się pobrać urządzeń.')
  return { devices: devices.data, agents: agents.data }
}

const ago = (iso: string | null, now: Date): string => {
  const age = ageSeconds(iso, now)
  return age === null ? 'nigdy' : `${formatAge(Math.max(0, age))} temu`
}

/** „3 z 4 działa” — liczone z włączonych urządzeń; status rozstrzyga serwer (D38, D52). */
export function summary(devices: readonly ApiDevice[]): { text: string; problems: number } {
  const enabled = devices.filter((d) => d.status !== 'DISABLED')
  const ok = enabled.filter((d) => d.status === 'OK').length
  return {
    text: `${ok} z ${enabled.length} działa`,
    problems: enabled.filter((d) => PROBLEMS.has(d.status)).length,
  }
}

const browserFetch: typeof fetch = (...args) => fetch(...args)

/** Status urządzeń i agentów instalacji (D52); odświeżanie co 30 s i po powrocie do karty. */
export function SiteDevicesPanel({
  siteId,
  now: fixedNow,
  fetchFn = browserFetch,
}: {
  siteId: string
  now?: Date
  fetchFn?: typeof fetch
}) {
  const { state, reload } = usePeriodic(
    `devices|${siteId}`,
    (_now, signal) => loadPanel(siteId, fetchFn, signal),
    DEVICES_REFRESH_MS,
  )
  const tickingNow = useNow(1000)
  const now = fixedNow ?? tickingNow

  let status: WidgetStatus
  if (state.status === 'loading') status = { kind: 'loading' }
  else if (state.status === 'error') status = { kind: 'error', onRetry: reload }
  else if (state.data.devices.length === 0) status = { kind: 'empty', message: 'Brak skonfigurowanych urządzeń.' }
  else status = { kind: 'ready' }

  const ready = state.status === 'ready' ? state : null
  const agents = new Map(ready?.data.agents.map((a) => [a.id, a]))
  const unreachable = ready?.data.agents.some((a) => a.status !== 'ONLINE') ?? false
  const counts = ready ? summary(ready.data.devices) : null

  return (
    <Panel
      title="Urządzenia"
      actions={<a href={devicesUrl(siteId)}>Lista urządzeń</a>}
    >
      <WidgetState
        status={status}
        staleNotice={ready?.failed ? 'Nie udało się odświeżyć — status z poprzedniego pobrania.' : null}
      >
        {ready && counts ? (
          <>
            <p className={styles.summary}>
              {counts.text}
              {counts.problems > 0 ? (
                <span className={styles.problems}>
                  {' '}
                  · wymaga uwagi: {counts.problems}
                </span>
              ) : null}
            </p>
            {ready.data.agents.length > 0 ? (
              <ul className={styles.agents} aria-label="Agenci">
                {ready.data.agents.map((a) => (
                  <li key={a.id} className={styles[a.status]}>
                    Agent {a.name} — {AGENT_STATUS_LABEL[a.status]}, heartbeat {ago(a.lastHeartbeatAt, now)}
                  </li>
                ))}
              </ul>
            ) : null}
            {unreachable ? (
              <p className={styles.warning} role="status">
                Agent nie odpowiada — statusy jego urządzeń są nieznane.
              </p>
            ) : null}
            <ul className={styles.list}>
              {ready.data.devices.map((d) => {
                const agent = d.agentId === null ? null : agents.get(d.agentId)
                return (
                  <li key={d.id} className={styles.item}>
                    <div className={styles.main}>
                      <span className={styles.title}>{d.name}</span>
                      <span className={styles.meta}>
                        {KIND_LABEL[d.kind] ?? d.kind} · ostatni odczyt {ago(d.lastSuccessAt, now)}
                        {d.agentId === null ? ' · brak agenta' : agent ? '' : ' · agent nieznany'}
                      </span>
                      <span className={styles.meta}>
                        Profil: <SupportLevelLabel level={d.supportLevel} />
                      </span>
                    </div>
                    <span className={`${styles.status} ${styles[d.status]}`}>
                      <span className={styles.dot} aria-hidden="true" />
                      {STATUS_LABEL[d.status]}
                    </span>
                  </li>
                )
              })}
            </ul>
          </>
        ) : null}
      </WidgetState>
    </Panel>
  )
}
