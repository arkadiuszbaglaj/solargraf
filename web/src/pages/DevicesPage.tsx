import type { FormEvent } from 'react'
import { useId, useState } from 'react'
import { assignLocation, loginUrl } from '../api/auth'
import type { ApiDevice, ApiProfile, ConnectionFieldErrors, ConnectionForm } from '../api/devices'
import { createConnection, listDevices, listProfiles, setDeviceEnabled, validateConnection } from '../api/devices'
import type { ApiSite } from '../api/sites'
import { getSite } from '../api/sites'
import { useOptionalSession } from '../auth/SessionContext'
import { Panel } from '../components/Panel'
import { WidgetState } from '../components/WidgetState'
import { useAsync } from '../hooks/useAsync'
import { KIND_LABEL, STATUS_LABEL } from '../lib/deviceLabels'
import { MISSING, formatDateTime } from '../lib/format'
import styles from './DevicesPage.module.css'

class SessionExpired extends Error {}

interface PageData {
  site: ApiSite
  devices: ApiDevice[]
}

export function DevicesPage({
  siteId,
  fetchFn = fetch,
  navigate = assignLocation,
}: {
  siteId: string
  fetchFn?: typeof fetch
  navigate?: (url: string) => void
}) {
  const auth = useOptionalSession()
  const expired = () => {
    navigate(loginUrl('expired'))
    return new SessionExpired()
  }
  const { state, reload } = useAsync<PageData | null>(
    async (signal) => {
      const site = await getSite(siteId, fetchFn, signal)
      if (site.kind === 'anonymous') throw expired()
      if (site.kind === 'not-found') return null
      if (site.kind === 'error') throw new Error('site')
      const devices = await listDevices(siteId, fetchFn, signal)
      if (devices.kind === 'anonymous') throw expired()
      if (devices.kind === 'error') throw new Error('devices')
      return { site: site.site, devices: devices.data }
    },
    [siteId, fetchFn, navigate],
  )
  const [rowMessage, setRowMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  if (state.status === 'loading') return <WidgetState status={{ kind: 'loading' }} />
  if (state.status === 'error') return <WidgetState status={{ kind: 'error', onRetry: reload }} />
  if (state.data === null) return <WidgetState status={{ kind: 'empty', message: 'Nie znaleziono instalacji.' }} />

  const { site, devices } = state.data
  // Zmieniać mogą OWNER i ADMIN (D29); ostatecznie decyduje serwer (D44).
  const canManage = auth !== null && site.role !== 'VIEWER'

  async function toggle(device: ApiDevice) {
    if (!auth) return
    setBusy(device.id)
    setRowMessage(null)
    const result = await setDeviceEnabled(site.id, device.id, !device.enabled, auth.session.csrfToken, fetchFn)
    setBusy(null)
    if (result.ok) reload()
    else if (result.anonymous) navigate(loginUrl('expired'))
    else setRowMessage(result.message)
  }

  return (
    <div className={styles.page}>
      <p>
        <a href="/instalacje">← Instalacje</a>
      </p>
      <Panel title={`Urządzenia — ${site.name}`}>
        {devices.length === 0 ? (
          <WidgetState
            status={{
              kind: 'empty',
              message: canManage ? 'Brak urządzeń. Dodaj pierwsze poniżej.' : 'Brak urządzeń w tej instalacji.',
            }}
          />
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
                  {canManage ? (
                    <>
                      <th scope="col">Profil</th>
                      <th scope="col">Adres</th>
                      <th scope="col">
                        <span className="visually-hidden">Akcje</span>
                      </th>
                    </>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <a
                        href={`/instalacje/${encodeURIComponent(site.id)}/urzadzenia/${encodeURIComponent(d.id)}/historia`}
                        title="Historia pomiarów"
                      >
                        {d.name}
                      </a>
                    </td>
                    <td>{KIND_LABEL[d.kind] ?? d.kind}</td>
                    <td>
                      <span className={`${styles.status} ${styles[d.status]}`}>
                        <span className={styles.dot} aria-hidden="true" />
                        {STATUS_LABEL[d.status]}
                      </span>
                    </td>
                    <td>{d.lastSuccessAt ? formatDateTime(d.lastSuccessAt, site.timezone) : MISSING}</td>
                    {canManage ? (
                      <>
                        <td>
                          {d.details?.profileId ?? MISSING}
                          {d.details?.profileId?.startsWith('simulated.') ? (
                            <span className={styles.simulated}> SIMULATED</span>
                          ) : null}
                        </td>
                        <td>
                          {d.details?.connection.host
                            ? `${d.details.connection.host}:${d.details.connection.port ?? 502}`
                            : MISSING}
                        </td>
                        <td>
                          <button
                            type="button"
                            className={styles.secondary}
                            disabled={busy === d.id}
                            aria-label={`${d.enabled ? 'Wyłącz' : 'Włącz'} urządzenie ${d.name}`}
                            onClick={() => void toggle(d)}
                          >
                            {d.enabled ? 'Wyłącz' : 'Włącz'}
                          </button>
                        </td>
                      </>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rowMessage ? (
          <p role="alert" className={styles.error}>
            {rowMessage}
          </p>
        ) : null}
      </Panel>
      {canManage ? (
        <AddDeviceForm
          siteId={site.id}
          csrfToken={auth.session.csrfToken}
          fetchFn={fetchFn}
          onCreated={reload}
          onExpired={() => navigate(loginUrl('expired'))}
        />
      ) : null}
    </div>
  )
}

const EMPTY_FORM: ConnectionForm = {
  name: '',
  host: '',
  port: '502',
  unitId: '1',
  pollIntervalSeconds: '',
  deviceName: '',
  profile: '',
}

function AddDeviceForm({
  siteId,
  csrfToken,
  fetchFn,
  onCreated,
  onExpired,
}: {
  siteId: string
  csrfToken: string
  fetchFn: typeof fetch
  onCreated: () => void
  onExpired: () => void
}) {
  const id = useId()
  const profiles = useAsync<ApiProfile[]>(
    async (signal) => {
      const result = await listProfiles(fetchFn, signal)
      if (result.kind !== 'ok') throw new Error('profiles')
      return result.data.filter((p) => p.modbusTcp)
    },
    [fetchFn],
  )
  const [form, setForm] = useState<ConnectionForm>(EMPTY_FORM)
  const [errors, setErrors] = useState<ConnectionFieldErrors>({})
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [pending, setPending] = useState(false)

  const available = profiles.state.status === 'ready' ? profiles.state.data : []
  const set = (field: keyof ConnectionForm) => (value: string) => setForm((f) => ({ ...f, [field]: value }))

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const { errors: found, input } = validateConnection(form, available)
    setErrors(found)
    setMessage(null)
    if (!input) return
    setPending(true)
    const result = await createConnection(siteId, input, csrfToken, fetchFn)
    setPending(false)
    if (result.ok) {
      setForm(EMPTY_FORM)
      setMessage({
        kind: 'ok',
        text: `Dodano „${result.data.name}”. Status pojawi się po pierwszym odczycie przez agenta.`,
      })
      onCreated()
    } else if (result.anonymous) {
      onExpired()
    } else {
      setMessage({ kind: 'error', text: result.message })
    }
  }

  const field = (
    name: keyof ConnectionForm & keyof ConnectionFieldErrors,
    label: string,
    props: { hint?: string; inputMode?: 'numeric'; placeholder?: string } = {},
  ) => {
    const describedBy = [props.hint ? `${id}-${name}-hint` : null, errors[name] ? `${id}-${name}-error` : null]
      .filter(Boolean)
      .join(' ')
    return (
      <div className={styles.field}>
        <label htmlFor={`${id}-${name}`}>{label}</label>
        <input
          id={`${id}-${name}`}
          value={form[name]}
          autoComplete="off"
          {...(props.inputMode ? { inputMode: props.inputMode } : {})}
          {...(props.placeholder ? { placeholder: props.placeholder } : {})}
          aria-invalid={errors[name] ? true : undefined}
          aria-describedby={describedBy || undefined}
          onChange={(e) => set(name)(e.target.value)}
        />
        {props.hint ? (
          <span id={`${id}-${name}-hint`} className={styles.muted}>
            {props.hint}
          </span>
        ) : null}
        {errors[name] ? (
          <span id={`${id}-${name}-error`} className={styles.error}>
            {errors[name]}
          </span>
        ) : null}
      </div>
    )
  }

  const selected = available.find((p) => `${p.id}@${p.version}` === form.profile)

  return (
    <Panel title="Dodaj urządzenie (Modbus TCP)">
      {profiles.state.status === 'loading' ? <WidgetState status={{ kind: 'loading' }} /> : null}
      {profiles.state.status === 'error' ? (
        <WidgetState status={{ kind: 'error', onRetry: profiles.reload }} />
      ) : null}
      {profiles.state.status === 'ready' && available.length === 0 ? (
        <WidgetState status={{ kind: 'empty', message: 'Brak profili urządzeń obsługujących Modbus TCP.' }} />
      ) : null}
      {available.length > 0 ? (
        <form className={styles.form} onSubmit={(e) => void onSubmit(e)} noValidate>
          <div className={styles.field}>
            <label htmlFor={`${id}-profile`}>Profil urządzenia</label>
            <select
              id={`${id}-profile`}
              value={form.profile}
              aria-invalid={errors.profile ? true : undefined}
              aria-describedby={errors.profile ? `${id}-profile-error` : undefined}
              onChange={(e) => set('profile')(e.target.value)}
            >
              <option value="">— wybierz —</option>
              {available.map((p) => (
                <option key={`${p.id}@${p.version}`} value={`${p.id}@${p.version}`}>
                  {p.simulated ? '[SIMULATED] ' : ''}
                  {p.manufacturer} — {p.name} ({p.version})
                </option>
              ))}
            </select>
            {selected?.simulated ? (
              <span className={styles.simulatedNote}>
                SIMULATED — profil symulatora do testów, nie prawdziwego urządzenia.
              </span>
            ) : null}
            {errors.profile ? (
              <span id={`${id}-profile-error`} className={styles.error}>
                {errors.profile}
              </span>
            ) : null}
          </div>
          {field('deviceName', 'Nazwa urządzenia', { placeholder: 'np. Falownik dach' })}
          {field('name', 'Nazwa połączenia', { placeholder: 'np. Logger w garażu' })}
          {field('host', 'Adres w sieci lokalnej', {
            hint: 'Prywatny adres IPv4 (np. 192.168.1.50) albo nazwa hosta. Łączy się z nim tylko agent.',
          })}
          <div className={styles.row}>
            {field('port', 'Port', { inputMode: 'numeric' })}
            {field('unitId', 'Unit ID', { inputMode: 'numeric' })}
            {field('pollIntervalSeconds', 'Interwał odczytu [s]', {
              inputMode: 'numeric',
              hint: selected ? `Puste = z profilu (${selected.pollIntervalSeconds} s).` : 'Puste = z profilu.',
            })}
          </div>
          {message ? (
            <p
              role={message.kind === 'ok' ? 'status' : 'alert'}
              className={message.kind === 'ok' ? styles.ok : styles.error}
            >
              {message.text}
            </p>
          ) : null}
          <button type="submit" className={styles.submit} disabled={pending}>
            {pending ? 'Dodawanie…' : 'Dodaj urządzenie'}
          </button>
        </form>
      ) : null}
    </Panel>
  )
}
