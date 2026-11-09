import { useState } from 'react'
import { assignLocation, loginUrl } from '../api/auth'
import type { ApiAgent, ApiDevice } from '../api/devices'
import { listDevices, listSiteAgents, setDeviceEnabled } from '../api/devices'
import type { ApiSite } from '../api/sites'
import { getSite } from '../api/sites'
import { useOptionalSession } from '../auth/SessionContext'
import { DemoBadge } from '../components/DemoBadge'
import { Panel } from '../components/Panel'
import { SupportLevelLabel } from '../components/SupportLevelLabel'
import { WidgetState } from '../components/WidgetState'
import type { Origin } from '../data/types'
import { usePeriodic } from '../hooks/usePeriodic'
import { type ConnectionGroup, groupByConnection } from '../lib/connections'
import { AGENT_STATUS_LABEL, KIND_LABEL, STATUS_LABEL } from '../lib/deviceLabels'
import { MISSING, formatAge, formatDateTime, formatSeconds } from '../lib/format'
import { devicesUrl } from '../paths'
import { AddDeviceForm } from './AddDeviceForm'
import { ConnectionSettingsForm } from './ConnectionSettingsForm'
import devices from './DevicesPage.module.css'
import styles from './InverterSettingsPage.module.css'

/** Status agenta i urządzeń wylicza serwer (D52) — odświeżamy co pół minuty, jak „Urządzenia”. */
export const INVERTER_REFRESH_MS = 30_000

class SessionExpired extends Error {}

interface PageData {
  site: ApiSite
  devices: ApiDevice[]
  agents: ApiAgent[]
}

/**
 * Ustawienia → Falownik: agent instalacji i połączenia z urządzeniami (adres, Unit ID, interwały),
 * kreator dodania z testem komunikacji (D72) i włączanie odczytu. Instalację wybiera przełącznik.
 * Zmieniać mogą OWNER i ADMIN (D29, D44); ostatecznie decyduje serwer.
 */
export function InverterSettingsPage({
  siteId,
  now,
  origin = 'DEVICE',
  fetchFn = fetch,
  navigate = assignLocation,
}: {
  siteId: string
  now: Date
  origin?: Origin
  fetchFn?: typeof fetch
  navigate?: (url: string) => void
}) {
  if (origin === 'DEMO') {
    return (
      <Panel title="Falownik" actions={<DemoBadge origin="DEMO" />}>
        <WidgetState
          status={{ kind: 'empty', message: 'Konfiguracja falownika wymaga serwera — niedostępna w trybie DEMO.' }}
        />
      </Panel>
    )
  }
  return <InverterSettings siteId={siteId} now={now} fetchFn={fetchFn} navigate={navigate} />
}

function InverterSettings({
  siteId,
  now,
  fetchFn,
  navigate,
}: {
  siteId: string
  now: Date
  fetchFn: typeof fetch
  navigate: (url: string) => void
}) {
  const auth = useOptionalSession()
  const expired = (): SessionExpired => {
    navigate(loginUrl('expired'))
    return new SessionExpired()
  }
  const { state, reload } = usePeriodic<PageData | null>(
    `inverter|${siteId}`,
    async (_now, signal) => {
      const site = await getSite(siteId, fetchFn, signal)
      if (site.kind === 'anonymous') throw expired()
      if (site.kind === 'not-found') return null
      if (site.kind === 'error') throw new Error('site')
      const [deviceList, agents] = await Promise.all([
        listDevices(siteId, fetchFn, signal),
        listSiteAgents(siteId, fetchFn, signal),
      ])
      if (deviceList.kind === 'anonymous' || agents.kind === 'anonymous') throw expired()
      if (deviceList.kind === 'error' || agents.kind === 'error') throw new Error('devices')
      return { site: site.site, devices: deviceList.data, agents: agents.data }
    },
    INVERTER_REFRESH_MS,
  )
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  if (state.status === 'loading') return <WidgetState status={{ kind: 'loading' }} />
  if (state.status === 'error') return <WidgetState status={{ kind: 'error', onRetry: reload }} />
  if (state.data === null) return <WidgetState status={{ kind: 'empty', message: 'Nie znaleziono instalacji.' }} />

  const { site, agents } = state.data
  if (!auth || site.role === 'VIEWER') {
    return (
      <Panel title="Falownik">
        <WidgetState
          status={{
            kind: 'empty',
            message: 'Konfigurację falownika zmienia właściciel albo administrator instalacji.',
          }}
        />
      </Panel>
    )
  }
  const csrfToken = auth.session.csrfToken
  const groups = groupByConnection(state.data.devices)
  const onExpired = () => navigate(loginUrl('expired'))

  async function toggle(device: ApiDevice) {
    setBusy(device.id)
    setMessage(null)
    const result = await setDeviceEnabled(site.id, device.id, !device.enabled, csrfToken, fetchFn)
    setBusy(null)
    if (result.ok) reload()
    else if (result.anonymous) onExpired()
    else setMessage({ kind: 'error', text: result.message })
  }

  return (
    <div className={devices.page}>
      <Panel title="Agent">
        <p className={devices.hint}>
          Agent działa w sieci lokalnej i jako jedyny łączy się z falownikiem. Aplikacja zmienia tylko jego
          konfigurację.
        </p>
        {agents.length === 0 ? (
          <WidgetState
            status={{ kind: 'empty', message: 'Brak agenta — pojawi się po dodaniu pierwszego urządzenia.' }}
          />
        ) : (
          <div className={devices.tableWrap}>
            <table className={devices.table}>
              <caption className="visually-hidden">Agenci instalacji {site.name}</caption>
              <thead>
                <tr>
                  <th scope="col">Nazwa</th>
                  <th scope="col">Status</th>
                  <th scope="col">Ostatni kontakt</th>
                  <th scope="col">Wersja</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => {
                  const age = a.lastHeartbeatAt ? (now.getTime() - Date.parse(a.lastHeartbeatAt)) / 1000 : null
                  return (
                    <tr key={a.id}>
                      <td>{a.name}</td>
                      <td>
                        <span className={`${styles.agent} ${styles[a.status] ?? ''}`}>
                          <span className={devices.dot} aria-hidden="true" />
                          {AGENT_STATUS_LABEL[a.status]}
                        </span>
                      </td>
                      <td>
                        {a.lastHeartbeatAt ? formatDateTime(a.lastHeartbeatAt, site.timezone) : 'nigdy'}
                        {age !== null ? (
                          <span className={devices.subLine}>{formatAge(Math.max(0, age))} temu</span>
                        ) : null}
                      </td>
                      <td>{a.version ?? 'niedostępna'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {agents.some((a) => a.status !== 'ONLINE') ? (
          <p className={devices.warn} role="status">
            Agent nie odpowiada — zmiany zaczną działać, gdy znów się połączy.
          </p>
        ) : null}
      </Panel>

      <Panel
        title="Połączenia z urządzeniami"
        actions={
          <button type="button" className={devices.secondary} aria-expanded={adding} onClick={() => setAdding((a) => !a)}>
            {adding ? 'Zamknij formularz' : 'Dodaj urządzenie'}
          </button>
        }
      >
        {message ? (
          <p role={message.kind === 'ok' ? 'status' : 'alert'} className={message.kind === 'ok' ? devices.ok : devices.error}>
            {message.text}
          </p>
        ) : null}
        {groups.length === 0 ? (
          <WidgetState
            status={{ kind: 'empty', message: 'Brak połączeń. Dodaj falownik przyciskiem „Dodaj urządzenie”.' }}
          />
        ) : (
          <ul className={styles.connections}>
            {groups.map((group) => (
              <li key={group.connection.id}>
                <ConnectionCard
                  group={group}
                  site={site}
                  editing={editing === group.connection.id}
                  busy={busy}
                  csrfToken={csrfToken}
                  fetchFn={fetchFn}
                  onEdit={() => {
                    setMessage(null)
                    setEditing(group.connection.id)
                  }}
                  onCancel={() => setEditing(null)}
                  onSaved={(name) => {
                    setEditing(null)
                    setMessage({ kind: 'ok', text: `Zapisano ustawienia połączenia „${name}”.` })
                    reload()
                  }}
                  onToggle={(d) => void toggle(d)}
                  onExpired={onExpired}
                />
              </li>
            ))}
          </ul>
        )}
        {state.failed ? (
          <p className={devices.muted}>Nie udało się odświeżyć — dane z poprzedniego pobrania.</p>
        ) : null}
      </Panel>

      {adding ? (
        <AddDeviceForm
          siteId={site.id}
          csrfToken={csrfToken}
          fetchFn={fetchFn}
          onCreated={reload}
          onExpired={onExpired}
        />
      ) : null}
    </div>
  )
}

function ConnectionCard({
  group,
  site,
  editing,
  busy,
  csrfToken,
  fetchFn,
  onEdit,
  onCancel,
  onSaved,
  onToggle,
  onExpired,
}: {
  group: ConnectionGroup
  site: ApiSite
  editing: boolean
  busy: string | null
  csrfToken: string
  fetchFn: typeof fetch
  onEdit: () => void
  onCancel: () => void
  onSaved: (name: string) => void
  onToggle: (device: ApiDevice) => void
  onExpired: () => void
}) {
  const { connection, profile, devices: list } = group
  const simulated = profile?.id.startsWith('simulated.') ?? false
  return (
    <article className={styles.card} aria-label={`Połączenie ${connection.name}`}>
      <header className={devices.subHeader}>
        <h3 className={devices.subTitle}>{connection.name}</h3>
        {editing ? null : (
          <button
            type="button"
            className={devices.secondary}
            aria-label={`Edytuj połączenie ${connection.name}`}
            onClick={onEdit}
          >
            Edytuj
          </button>
        )}
      </header>
      {editing ? (
        <ConnectionSettingsForm
          siteId={site.id}
          connection={connection}
          profile={profile}
          csrfToken={csrfToken}
          fetchFn={fetchFn}
          onSaved={(c) => onSaved(c.name)}
          onCancel={onCancel}
          onExpired={onExpired}
        />
      ) : (
        <dl className={devices.facts}>
          <dt>Adres</dt>
          <dd>{connection.host ? `${connection.host}:${connection.port ?? 502}` : MISSING}</dd>
          <dt>Unit ID</dt>
          <dd>{connection.unitId ?? MISSING}</dd>
          <dt>Interwał odczytu</dt>
          <dd>{connection.pollIntervalSeconds !== null ? `${connection.pollIntervalSeconds} s` : 'z profilu'}</dd>
          <dt>Odświeżanie na żywo</dt>
          <dd>
            {connection.liveIntervalSeconds !== null ? formatSeconds(connection.liveIntervalSeconds) : 'z profilu'}
          </dd>
          <dt>Profil</dt>
          <dd>
            {profile ? `${profile.id} (${profile.version})` : MISSING}
            {simulated ? <span className={devices.simulated}> SIMULATED</span> : null}
          </dd>
        </dl>
      )}
      <ul className={styles.devices} aria-label={`Urządzenia połączenia ${connection.name}`}>
        {list.map((d) => (
          <li key={d.id} className={styles.device}>
            <div className={styles.deviceMain}>
              <a href={devicesUrl(site.id, d.id)}>{d.name}</a>
              <span className={devices.subLine}>
                {KIND_LABEL[d.kind] ?? d.kind} · <SupportLevelLabel level={d.supportLevel} />
              </span>
            </div>
            <span className={`${devices.status} ${devices[d.status]}`}>
              <span className={devices.dot} aria-hidden="true" />
              {STATUS_LABEL[d.status]}
            </span>
            <button
              type="button"
              className={devices.secondary}
              disabled={busy === d.id}
              aria-label={`${d.enabled ? 'Wyłącz' : 'Włącz'} odczyt urządzenia ${d.name}`}
              onClick={() => onToggle(d)}
            >
              {d.enabled ? 'Wyłącz odczyt' : 'Włącz odczyt'}
            </button>
          </li>
        ))}
      </ul>
    </article>
  )
}
