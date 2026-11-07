import type { FormEvent } from 'react'
import { useId, useMemo, useState } from 'react'
import type { Role } from '../api/auth'
import { assignLocation, loginUrl } from '../api/auth'
import type { SiteFieldErrors } from '../api/sites'
import { DEFAULT_TIMEZONE, NAME_MAX, createSite, listSites, timezoneOptions, validateSite } from '../api/sites'
import { useOptionalSession } from '../auth/SessionContext'
import { Panel } from '../components/Panel'
import { WidgetState } from '../components/WidgetState'
import { useAsync } from '../hooks/useAsync'
import styles from './SitesPage.module.css'

const ROLE_LABEL: Record<Role, string> = { OWNER: 'Właściciel', ADMIN: 'Administrator', VIEWER: 'Podgląd' }

class SessionExpired extends Error {}

export function SitesPage({
  fetchFn = fetch,
  navigate = assignLocation,
}: {
  fetchFn?: typeof fetch
  navigate?: (url: string) => void
}) {
  const auth = useOptionalSession()
  const { state, reload } = useAsync(
    async (signal) => {
      const result = await listSites(fetchFn, signal)
      if (result.kind === 'anonymous') {
        navigate(loginUrl('expired'))
        throw new SessionExpired()
      }
      if (result.kind === 'error') throw new Error('sites')
      return result.sites
    },
    [fetchFn, navigate],
  )

  // Dodawać mogą OWNER i ADMIN (D29); ostatecznie decyduje serwer (D33).
  const manageable = (auth?.session.memberships ?? []).filter((m) => m.role !== 'VIEWER')

  return (
    <div className={styles.page}>
      <p className={styles.notice}>
        Dane pomiarowe pojawią się po podłączeniu urządzeń. Do tego czasu dashboard pokazuje dane DEMO.
      </p>
      <Panel title="Instalacje">
        {state.status === 'loading' ? <WidgetState status={{ kind: 'loading' }} /> : null}
        {state.status === 'error' ? <WidgetState status={{ kind: 'error', onRetry: reload }} /> : null}
        {state.status === 'ready' && state.data.length === 0 ? (
          <WidgetState status={{ kind: 'empty', message: 'Brak instalacji. Dodaj pierwszą poniżej.' }} />
        ) : null}
        {state.status === 'ready' && state.data.length > 0 ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className="visually-hidden">Instalacje dostępne dla Twojego konta</caption>
              <thead>
                <tr>
                  <th scope="col">Nazwa</th>
                  <th scope="col">Strefa czasowa</th>
                  <th scope="col">Twoja rola</th>
                  <th scope="col">
                    <span className="visually-hidden">Akcje</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {state.data.map((s) => (
                  <tr key={s.id}>
                    <td>{s.name}</td>
                    <td>{s.timezone}</td>
                    <td>{ROLE_LABEL[s.role]}</td>
                    <td>
                      <a href={`/instalacje/${encodeURIComponent(s.id)}/urzadzenia`}>
                        Urządzenia<span className="visually-hidden"> instalacji {s.name}</span>
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Panel>
      {auth && manageable.length > 0 ? (
        <AddSiteForm
          organizations={manageable.map((m) => ({ id: m.organizationId, name: m.organizationName }))}
          csrfToken={auth.session.csrfToken}
          fetchFn={fetchFn}
          onCreated={reload}
          onExpired={() => navigate(loginUrl('expired'))}
        />
      ) : null}
    </div>
  )
}

function AddSiteForm({
  organizations,
  csrfToken,
  fetchFn,
  onCreated,
  onExpired,
}: {
  organizations: { id: string; name: string }[]
  csrfToken: string
  fetchFn: typeof fetch
  onCreated: () => void
  onExpired: () => void
}) {
  const id = useId()
  const zones = useMemo(() => timezoneOptions(), [])
  const [organizationId, setOrganizationId] = useState(organizations[0]?.id ?? '')
  const [name, setName] = useState('')
  const [timezone, setTimezone] = useState(DEFAULT_TIMEZONE)
  const [errors, setErrors] = useState<SiteFieldErrors>({})
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const input = { organizationId, name: name.trim(), timezone: timezone.trim() }
    const found = validateSite(input, zones)
    setErrors(found)
    setMessage(null)
    if (Object.keys(found).length > 0) return
    setPending(true)
    const result = await createSite(input, csrfToken, fetchFn)
    setPending(false)
    if (result.ok) {
      setName('')
      setMessage({ kind: 'ok', text: `Dodano instalację „${result.site.name}”.` })
      onCreated()
    } else if (result.anonymous) {
      onExpired()
    } else {
      setMessage({ kind: 'error', text: result.message })
    }
  }

  const describe = (field: keyof SiteFieldErrors, hint?: string) =>
    [hint, errors[field] ? `${id}-${field}-error` : null].filter(Boolean).join(' ') || undefined

  return (
    <Panel title="Dodaj instalację">
      <form className={styles.form} onSubmit={(e) => void onSubmit(e)} noValidate>
        {organizations.length > 1 ? (
          <div className={styles.field}>
            <label htmlFor={`${id}-org`}>Organizacja</label>
            <select id={`${id}-org`} value={organizationId} onChange={(e) => setOrganizationId(e.target.value)}>
              {organizations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className={styles.field}>
          <label htmlFor={`${id}-name`}>Nazwa</label>
          <input
            id={`${id}-name`}
            value={name}
            maxLength={NAME_MAX}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={describe('name')}
            onChange={(e) => setName(e.target.value)}
          />
          {errors.name ? (
            <span id={`${id}-name-error`} className={styles.error}>
              {errors.name}
            </span>
          ) : null}
        </div>
        <div className={styles.field}>
          <label htmlFor={`${id}-tz`}>Strefa czasowa</label>
          <input
            id={`${id}-tz`}
            list={`${id}-zones`}
            value={timezone}
            autoComplete="off"
            aria-invalid={errors.timezone ? true : undefined}
            aria-describedby={describe('timezone', `${id}-tz-hint`)}
            onChange={(e) => setTimezone(e.target.value)}
          />
          <datalist id={`${id}-zones`}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </datalist>
          <span id={`${id}-tz-hint`} className={styles.muted}>
            Czas w panelu będzie pokazywany w tej strefie. Zacznij pisać, np. „Europe”.
          </span>
          {errors.timezone ? (
            <span id={`${id}-timezone-error`} className={styles.error}>
              {errors.timezone}
            </span>
          ) : null}
        </div>
        {message ? (
          <p role={message.kind === 'ok' ? 'status' : 'alert'} className={message.kind === 'ok' ? styles.ok : styles.error}>
            {message.text}
          </p>
        ) : null}
        <button type="submit" className={styles.submit} disabled={pending}>
          {pending ? 'Dodawanie…' : 'Dodaj instalację'}
        </button>
      </form>
    </Panel>
  )
}
