import { useId, useState } from 'react'
import { assignLocation, loginUrl } from '../api/auth'
import type { ApiDevice } from '../api/devices'
import { listDevices } from '../api/devices'
import { browserLiveSource, type LiveSourceFactory } from '../api/live'
import type { ApiSite } from '../api/sites'
import { getSite } from '../api/sites'
import { useOptionalSession } from '../auth/SessionContext'
import { DemoBadge } from '../components/DemoBadge'
import { Panel } from '../components/Panel'
import { SupportLevelLabel } from '../components/SupportLevelLabel'
import { WidgetState } from '../components/WidgetState'
import type { Origin } from '../data/types'
import { useLiveSite } from '../hooks/useLiveSite'
import { usePeriodic } from '../hooks/usePeriodic'
import { KIND_LABEL, STATUS_LABEL } from '../lib/deviceLabels'
import {
  type DeviceFilter,
  filterDevices,
  NO_FILTER,
  presentKinds,
  STATUS_GROUP_LABEL,
  type StatusGroup,
  statusCounts,
} from '../lib/deviceList'
import { MISSING, formatAge, formatDateTime } from '../lib/format'
import { devicesUrl, inverterSettingsUrl } from '../paths'
import { DeviceDetails } from './DeviceDetails'
import styles from './DevicesPage.module.css'

/** Status urządzeń wylicza serwer z polityki świeżości (D52) — odświeżamy listę co pół minuty. */
export const DEVICES_REFRESH_MS = 30_000

class SessionExpired extends Error {}

interface PageData {
  site: ApiSite
  devices: ApiDevice[]
}

const GROUPS: StatusGroup[] = ['OK', 'ATTENTION', 'UNKNOWN', 'DISABLED']

const historyUrl = (siteId: string, deviceId: string): string =>
  `/instalacje/${encodeURIComponent(siteId)}/urzadzenia/${encodeURIComponent(deviceId)}/historia`

/**
 * Zakładka „Urządzenia” instalacji wybranej w przełączniku: kafle statusów, wyszukiwanie i filtry,
 * tabela i panel szczegółów wybranego urządzenia. Adres i profil widzą tylko OWNER/ADMIN (D38).
 * Dodawanie, edycja połączeń i włączanie odczytu są w Ustawieniach → Falownik (D80).
 */
export function DevicesPage({
  siteId,
  now,
  origin = 'DEVICE',
  initialDeviceId = '',
  fetchFn = fetch,
  navigate = assignLocation,
  liveFactory = browserLiveSource,
}: {
  siteId: string
  now: Date
  origin?: Origin
  initialDeviceId?: string
  fetchFn?: typeof fetch
  navigate?: (url: string) => void
  liveFactory?: LiveSourceFactory
}) {
  if (origin === 'DEMO') {
    return (
      <Panel title="Urządzenia" actions={<DemoBadge origin="DEMO" />}>
        <WidgetState
          status={{ kind: 'empty', message: 'Lista urządzeń wymaga serwera — niedostępna w trybie DEMO.' }}
        />
      </Panel>
    )
  }
  return (
    <DevicesTab
      siteId={siteId}
      now={now}
      initialDeviceId={initialDeviceId}
      fetchFn={fetchFn}
      navigate={navigate}
      liveFactory={liveFactory}
    />
  )
}

function DevicesTab({
  siteId,
  now,
  initialDeviceId,
  fetchFn,
  navigate,
  liveFactory,
}: {
  siteId: string
  now: Date
  initialDeviceId: string
  fetchFn: typeof fetch
  navigate: (url: string) => void
  liveFactory: LiveSourceFactory
}) {
  const id = useId()
  const auth = useOptionalSession()
  const expired = (): SessionExpired => {
    navigate(loginUrl('expired'))
    return new SessionExpired()
  }
  const { state, reload } = usePeriodic<PageData | null>(
    `devices|${siteId}`,
    async (_now, signal) => {
      const site = await getSite(siteId, fetchFn, signal)
      if (site.kind === 'anonymous') throw expired()
      if (site.kind === 'not-found') return null
      if (site.kind === 'error') throw new Error('site')
      const devices = await listDevices(siteId, fetchFn, signal)
      if (devices.kind === 'anonymous') throw expired()
      if (devices.kind === 'error') throw new Error('devices')
      return { site: site.site, devices: devices.data }
    },
    DEVICES_REFRESH_MS,
  )
  const live = useLiveSite(siteId, liveFactory)
  const [filter, setFilter] = useState<DeviceFilter>(NO_FILTER)
  const [selectedId, setSelectedId] = useState(initialDeviceId)

  if (state.status === 'loading') return <WidgetState status={{ kind: 'loading' }} />
  if (state.status === 'error') return <WidgetState status={{ kind: 'error', onRetry: reload }} />
  if (state.data === null) return <WidgetState status={{ kind: 'empty', message: 'Nie znaleziono instalacji.' }} />

  const { site, devices } = state.data
  // Zmieniać mogą OWNER i ADMIN (D29); ostatecznie decyduje serwer (D44).
  const canManage = auth !== null && site.role !== 'VIEWER'
  const counts = statusCounts(devices)
  const visible = filterDevices(devices, filter)
  const selected = visible.find((d) => d.id === selectedId) ?? visible[0] ?? null
  const kinds = presentKinds(devices)
  const setGroup = (group: StatusGroup | '') => setFilter((f) => ({ ...f, group }))

  function select(device: ApiDevice) {
    setSelectedId(device.id)
    window.history.replaceState(null, '', devicesUrl(site.id, device.id))
    // Na wąskim ekranie panel jest pod listą — przenosimy tam fokus i widok.
    requestAnimationFrame(() => {
      const heading = document.getElementById(`${id}-details`)?.querySelector('h2')
      heading?.focus()
    })
  }

  return (
    <div className={styles.page}>
      <div className={styles.tiles} role="group" aria-label="Liczba urządzeń według statusu">
        <button
          type="button"
          className={styles.tile}
          aria-pressed={filter.group === ''}
          aria-label={`Wszystkie: ${devices.length}`}
          onClick={() => setGroup('')}
        >
          <span className={styles.tileValue}>{devices.length}</span>
          <span className={styles.tileLabel}>Wszystkie</span>
        </button>
        {GROUPS.filter((g) => g !== 'DISABLED' || counts.DISABLED > 0).map((g) => (
          <button
            key={g}
            type="button"
            className={`${styles.tile} ${styles[`tile${g}`] ?? ''}`}
            aria-pressed={filter.group === g}
            aria-label={`${STATUS_GROUP_LABEL[g]}: ${counts[g]}`}
            onClick={() => setGroup(filter.group === g ? '' : g)}
          >
            <span className={styles.tileValue}>{counts[g]}</span>
            <span className={styles.tileLabel}>{STATUS_GROUP_LABEL[g]}</span>
          </button>
        ))}
      </div>

      <div className={styles.layout}>
        <Panel
          title="Lista urządzeń"
          {...(styles.listPanel ? { className: styles.listPanel } : {})}
          actions={
            canManage ? <a href={inverterSettingsUrl(site.id)}>Konfiguracja połączeń</a> : null
          }
        >
          <div className={styles.filters}>
            <div className={`${styles.field} ${styles.search}`}>
              <label htmlFor={`${id}-q`}>Szukaj urządzenia</label>
              <input
                id={`${id}-q`}
                type="search"
                value={filter.query}
                autoComplete="off"
                placeholder="Nazwa, typ, producent…"
                onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
              />
            </div>
            <div className={styles.field}>
              <label htmlFor={`${id}-kind`}>Typ</label>
              <select
                id={`${id}-kind`}
                value={filter.kind}
                onChange={(e) => setFilter((f) => ({ ...f, kind: e.target.value }))}
              >
                <option value="">Wszystkie</option>
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k] ?? k}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <label htmlFor={`${id}-status`}>Status</label>
              <select
                id={`${id}-status`}
                value={filter.group}
                onChange={(e) => setGroup(e.target.value as StatusGroup | '')}
              >
                <option value="">Wszystkie</option>
                {GROUPS.map((g) => (
                  <option key={g} value={g}>
                    {STATUS_GROUP_LABEL[g]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {devices.length === 0 ? (
            <WidgetState
              status={{
                kind: 'empty',
                message: canManage
                  ? 'Brak urządzeń. Dodaj pierwsze w Ustawieniach → Falownik.'
                  : 'Brak urządzeń w tej instalacji.',
              }}
            />
          ) : visible.length === 0 ? (
            <WidgetState status={{ kind: 'empty', message: 'Żadne urządzenie nie pasuje do filtrów.' }} />
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption className="visually-hidden">Urządzenia instalacji {site.name}</caption>
                <thead>
                  <tr>
                    <th scope="col">Nazwa</th>
                    <th scope="col">Typ</th>
                    <th scope="col">Status</th>
                    <th scope="col">Ostatni odczyt</th>
                    {canManage ? <th scope="col">Adres</th> : null}
                    <th scope="col">Wsparcie profilu</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((d) => {
                    const current = selected?.id === d.id
                    const age = d.lastSuccessAt ? (now.getTime() - Date.parse(d.lastSuccessAt)) / 1000 : null
                    return (
                      <tr key={d.id} className={current ? styles.selectedRow : undefined}>
                        <td>
                          <button
                            type="button"
                            className={styles.rowButton}
                            aria-current={current ? 'true' : undefined}
                            onClick={() => select(d)}
                          >
                            {d.name}
                          </button>
                          {d.manufacturer || d.model ? (
                            <span className={styles.subLine}>{[d.manufacturer, d.model].filter(Boolean).join(' ')}</span>
                          ) : null}
                        </td>
                        <td>{KIND_LABEL[d.kind] ?? d.kind}</td>
                        <td>
                          <span className={`${styles.status} ${styles[d.status]}`}>
                            <span className={styles.dot} aria-hidden="true" />
                            {STATUS_LABEL[d.status]}
                          </span>
                        </td>
                        <td>
                          {d.lastSuccessAt ? formatDateTime(d.lastSuccessAt, site.timezone) : MISSING}
                          {age !== null ? <span className={styles.subLine}>{formatAge(Math.max(0, age))} temu</span> : null}
                        </td>
                        {canManage ? (
                          <td>
                            {d.details?.connection.host
                              ? `${d.details.connection.host}:${d.details.connection.port ?? 502}`
                              : MISSING}
                            {d.details?.profileId?.startsWith('simulated.') ? (
                              <span className={styles.simulated}> SIMULATED</span>
                            ) : null}
                          </td>
                        ) : null}
                        <td>
                          <SupportLevelLabel level={d.supportLevel} />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className={styles.muted}>
            Wyświetlono {visible.length} z {devices.length} urządzeń.
            {state.failed ? ' Nie udało się odświeżyć listy — statusy mogą być nieaktualne.' : ''}
          </p>
        </Panel>

        <div id={`${id}-details`} className={styles.detailsColumn}>
          {selected ? (
            <DeviceDetails
              key={selected.id}
              device={selected}
              siteId={site.id}
              timeZone={site.timezone}
              now={now}
              live={live.state}
              configureUrl={canManage ? inverterSettingsUrl(site.id) : null}
              onExpired={() => navigate(loginUrl('expired'))}
              historyUrl={historyUrl(site.id, selected.id)}
              fetchFn={fetchFn}
            />
          ) : null}
        </div>
      </div>

    </div>
  )
}
