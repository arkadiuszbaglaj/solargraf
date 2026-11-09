import type { FormEvent } from 'react'
import { useId, useState } from 'react'
import type { ApiProfile, ConnectionFieldErrors, ConnectionForm } from '../api/devices'
import { createConnection, listProfiles, validateConnection, validateTarget } from '../api/devices'
import { Panel } from '../components/Panel'
import { WidgetState } from '../components/WidgetState'
import { useAsync } from '../hooks/useAsync'
import { SUPPORT_LEVEL } from '../lib/deviceLabels'
import { formatSeconds } from '../lib/format'
import { ConnectionTestResult, useConnectionTest } from './ConnectionTestResult'
import styles from './DevicesPage.module.css'

const EMPTY_FORM: ConnectionForm = {
  name: '',
  host: '',
  port: '502',
  unitId: '1',
  pollIntervalSeconds: '',
  liveIntervalSeconds: '',
  deviceName: '',
  profile: '',
}

const TARGET_FIELDS: ReadonlySet<keyof ConnectionForm> = new Set(['host', 'port', 'unitId', 'profile'])

/**
 * Kreator dodania urządzenia Modbus TCP (D44, D72): profil i adres → test komunikacji przez agenta →
 * nazwy i zapis. Test jest zalecany, ale nie wymagany (urządzenie może być chwilowo wyłączone).
 * Zapis tylko OWNER/ADMIN.
 */
export function AddDeviceForm({
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
  const test = useConnectionTest(siteId, csrfToken, fetchFn, onExpired)
  const set = (field: keyof ConnectionForm) => (value: string) => {
    // Wynik testu dotyczy konkretnego adresu i profilu — po zmianie jest nieaktualny.
    if (TARGET_FIELDS.has(field)) test.reset()
    setForm((f) => ({ ...f, [field]: value }))
  }

  function onTest() {
    const { errors: found, target } = validateTarget(form, available)
    setErrors(found)
    setMessage(null)
    if (target) void test.start(target)
  }

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
      test.reset()
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
    props: { hint?: string; inputMode?: 'numeric' | 'decimal'; placeholder?: string } = {},
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
          <fieldset className={styles.step}>
            <legend>1. Profil i adres</legend>
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
                    {p.supportLevel ? ` — ${SUPPORT_LEVEL[p.supportLevel].label}` : ''}
                  </option>
                ))}
              </select>
              {selected?.simulated ? (
                <span className={styles.simulatedNote}>
                  SIMULATED — profil symulatora do testów, nie prawdziwego urządzenia.
                </span>
              ) : null}
              {selected?.supportLevel ? (
                <span className={styles.hint}>
                  Wsparcie profilu: {SUPPORT_LEVEL[selected.supportLevel].label}. {SUPPORT_LEVEL[selected.supportLevel].description}
                </span>
              ) : null}
              {errors.profile ? (
                <span id={`${id}-profile-error`} className={styles.error}>
                  {errors.profile}
                </span>
              ) : null}
            </div>
            {field('host', 'Adres w sieci lokalnej', {
              hint: 'Prywatny adres IPv4 (np. 192.168.1.50) albo nazwa hosta. Łączy się z nim tylko agent.',
            })}
            <div className={styles.row}>
              {field('port', 'Port', { inputMode: 'numeric' })}
              {field('unitId', 'Unit ID', { inputMode: 'numeric' })}
            </div>
          </fieldset>
          <fieldset className={styles.step}>
            <legend>2. Test komunikacji</legend>
            <p className={styles.hint}>
              Agent jednorazowo odczyta urządzenie wybranym profilem. Nic nie jest zapisywane do urządzenia ani do
              historii.
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
          </fieldset>
          <fieldset className={styles.step}>
            <legend>3. Nazwy i zapis</legend>
            {field('deviceName', 'Nazwa urządzenia', { placeholder: 'np. Falownik dach' })}
            {field('name', 'Nazwa połączenia', { placeholder: 'np. Logger w garażu' })}
            {field('pollIntervalSeconds', 'Interwał odczytu [s]', {
              inputMode: 'numeric',
              hint: selected
                ? `Co tyle zapis do historii. Puste = z profilu (${selected.pollIntervalSeconds} s).`
                : 'Co tyle zapis do historii. Puste = z profilu.',
            })}
            {field('liveIntervalSeconds', 'Odświeżanie na żywo [s]', {
              inputMode: 'decimal',
              hint: `Tylko podgląd na żywo, bez zapisu. Puste = z profilu (${
                selected?.liveIntervalSeconds != null ? formatSeconds(selected.liveIntervalSeconds) : 'jak interwał odczytu'
              }).`,
            })}
          </fieldset>
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
