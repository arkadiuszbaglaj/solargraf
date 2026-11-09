import type { FormEvent } from 'react'
import { useId, useState } from 'react'
import type { ApiConnection, ApiProfile, ConnectionFieldErrors, ConnectionSettingsForm as Form } from '../api/devices'
import { listProfiles, updateConnection, validateConnectionSettings, validateTarget } from '../api/devices'
import { useAsync } from '../hooks/useAsync'
import { formatSeconds } from '../lib/format'
import { ConnectionTestResult, useConnectionTest } from './ConnectionTestResult'
import styles from './DevicesPage.module.css'

const TARGET_FIELDS: ReadonlySet<keyof Form> = new Set(['host', 'port', 'unitId'])

const toForm = (c: ApiConnection): Form => ({
  name: c.name,
  host: c.host ?? '',
  port: String(c.port ?? 502),
  unitId: String(c.unitId ?? 1),
  pollIntervalSeconds: c.pollIntervalSeconds === null ? '' : String(c.pollIntervalSeconds),
  liveIntervalSeconds: c.liveIntervalSeconds === null ? '' : String(c.liveIntervalSeconds).replace('.', ','),
})

/**
 * Edycja istniejącego połączenia Modbus TCP (D44): nazwa, adres, port, Unit ID i interwały.
 * Profil urządzeń się nie zmienia. Test komunikacji (D72) tylko dla profilu z katalogu serwera.
 */
export function ConnectionSettingsForm({
  siteId,
  connection,
  profile,
  csrfToken,
  fetchFn,
  onSaved,
  onCancel,
  onExpired,
}: {
  siteId: string
  connection: ApiConnection
  profile: { id: string; version: string } | null
  csrfToken: string
  fetchFn: typeof fetch
  onSaved: (connection: ApiConnection) => void
  onCancel: () => void
  onExpired: () => void
}) {
  const id = useId()
  const profiles = useAsync<ApiProfile[]>(
    async (signal) => {
      const result = await listProfiles(fetchFn, signal)
      if (result.kind !== 'ok') throw new Error('profiles')
      return result.data
    },
    [fetchFn],
  )
  const [form, setForm] = useState<Form>(() => toForm(connection))
  const [errors, setErrors] = useState<ConnectionFieldErrors>({})
  const [message, setMessage] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const test = useConnectionTest(siteId, csrfToken, fetchFn, onExpired)

  const catalog = profiles.state.status === 'ready' ? profiles.state.data : []
  const known = profile ? catalog.find((p) => p.id === profile.id && p.version === profile.version) : undefined
  const profilePoll = known?.pollIntervalSeconds ?? null

  const set = (field: keyof Form) => (value: string) => {
    if (TARGET_FIELDS.has(field)) test.reset()
    setForm((f) => ({ ...f, [field]: value }))
  }

  function onTest() {
    if (!known) return
    const { errors: found, target } = validateTarget({ ...form, profile: `${known.id}@${known.version}` }, catalog)
    setErrors(found)
    setMessage(null)
    if (target) void test.start(target)
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const { errors: found, input } = validateConnectionSettings(form, profilePoll, connection.timeoutSeconds)
    setErrors(found)
    setMessage(null)
    if (!input) return
    setPending(true)
    const result = await updateConnection(siteId, connection.id, input, csrfToken, fetchFn)
    setPending(false)
    if (result.ok) onSaved(result.data)
    else if (result.anonymous) onExpired()
    else setMessage(result.message)
  }

  const field = (
    name: keyof Form,
    label: string,
    props: { hint?: string; inputMode?: 'numeric' | 'decimal' } = {},
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

  return (
    <form
      className={styles.form}
      onSubmit={(e) => void onSubmit(e)}
      noValidate
      aria-label={`Edycja połączenia ${connection.name}`}
    >
      {field('name', 'Nazwa połączenia')}
      {field('host', 'Adres w sieci lokalnej', {
        hint: 'Prywatny adres IPv4 albo nazwa hosta. Łączy się z nim tylko agent.',
      })}
      <div className={styles.row}>
        {field('port', 'Port', { inputMode: 'numeric' })}
        {field('unitId', 'Unit ID', { inputMode: 'numeric' })}
      </div>
      {field('pollIntervalSeconds', 'Interwał odczytu [s]', {
        inputMode: 'numeric',
        hint: `Co tyle zapis do historii. Puste = z profilu${profilePoll !== null ? ` (${profilePoll} s)` : ''}.`,
      })}
      {field('liveIntervalSeconds', 'Odświeżanie na żywo [s]', {
        inputMode: 'decimal',
        hint: `Tylko podgląd na żywo, bez zapisu. Puste = z profilu${
          known?.liveIntervalSeconds != null ? ` (${formatSeconds(known.liveIntervalSeconds)})` : ''
        }.`,
      })}
      {known ? (
        <div>
          <p className={styles.hint}>
            Test sprawdza nowy adres przed zapisem. Pod adresem już odczytywanym agent testu nie wykona.
          </p>
          <button
            type="button"
            className={styles.secondary}
            disabled={test.run.status === 'waiting'}
            onClick={onTest}
          >
            {test.run.status === 'waiting' ? 'Testowanie…' : 'Testuj połączenie'}
          </button>
          <ConnectionTestResult run={test.run} />
        </div>
      ) : null}
      {message ? (
        <p role="alert" className={styles.error}>
          {message}
        </p>
      ) : null}
      <div className={styles.detailsActions}>
        <button type="submit" className={styles.submit} disabled={pending}>
          {pending ? 'Zapisywanie…' : 'Zapisz połączenie'}
        </button>
        <button type="button" className={styles.secondary} onClick={onCancel}>
          Anuluj
        </button>
      </div>
    </form>
  )
}
