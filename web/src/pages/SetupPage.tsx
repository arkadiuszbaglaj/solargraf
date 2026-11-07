import type { FormEvent } from 'react'
import { useId, useState } from 'react'
import type { FieldErrors, SetupFields } from '../api/setup'
import { PASSWORD_MAX, PASSWORD_MIN, postSetup, validateSetup } from '../api/setup'
import { branding } from '../branding'
import styles from './SetupPage.module.css'

/** Odczytuje token z adresu i usuwa go z paska adresu oraz historii przeglądarki. */
export function takeTokenFromLocation(): string {
  const params = new URLSearchParams(window.location.search)
  const token = params.get('token') ?? ''
  if (token) {
    window.history.replaceState(null, '', window.location.pathname)
  }
  return token
}

const EMPTY: SetupFields = {
  organizationName: '',
  displayName: '',
  email: '',
  password: '',
  passwordRepeat: '',
}

const FIELDS: {
  name: keyof SetupFields
  label: string
  type: string
  autoComplete: string
  hint?: string
}[] = [
  { name: 'organizationName', label: 'Nazwa organizacji', type: 'text', autoComplete: 'organization' },
  { name: 'displayName', label: 'Imię i nazwisko', type: 'text', autoComplete: 'name' },
  { name: 'email', label: 'E-mail (login)', type: 'email', autoComplete: 'email' },
  {
    name: 'password',
    label: 'Hasło',
    type: 'password',
    autoComplete: 'new-password',
    hint: `Od ${PASSWORD_MIN} do ${PASSWORD_MAX} znaków.`,
  },
  { name: 'passwordRepeat', label: 'Powtórz hasło', type: 'password', autoComplete: 'new-password' },
]

export function SetupPage({
  token,
  submit = postSetup,
}: {
  token: string
  submit?: typeof postSetup
}) {
  const formId = useId()
  const [fields, setFields] = useState<SetupFields>(EMPTY)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [serverError, setServerError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [done, setDone] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const found = validateSetup(fields)
    setErrors(found)
    setServerError(null)
    if (Object.keys(found).length > 0) return
    setPending(true)
    const result = await submit({
      token,
      organizationName: fields.organizationName.trim(),
      displayName: fields.displayName.trim(),
      email: fields.email.trim(),
      password: fields.password,
    })
    setPending(false)
    if (result.ok) {
      setFields(EMPTY)
      setDone(true)
    } else {
      setServerError(result.message)
    }
  }

  let content
  if (done) {
    content = (
      <div role="status">
        <p>Konto właściciela zostało utworzone. Link konfiguracji wygasł i nie zadziała ponownie.</p>
        <p className={styles.muted}>
          Logowanie w interfejsie pojawi się w kolejnej wersji. Do tego czasu panel pokazuje dane DEMO.
        </p>
        <p>
          <a href="/">Przejdź do panelu</a>
        </p>
      </div>
    )
  } else if (!token) {
    content = (
      <p role="alert" className={styles.error}>
        Brak tokenu konfiguracji. Otwórz pełny link wypisany przez instalator.
      </p>
    )
  } else {
    content = (
      <form className={styles.form} onSubmit={(e) => void onSubmit(e)} noValidate>
        {FIELDS.map((f) => {
          const id = `${formId}-${f.name}`
          const error = errors[f.name]
          const describedBy = [f.hint ? `${id}-hint` : null, error ? `${id}-error` : null]
            .filter(Boolean)
            .join(' ')
          return (
            <div key={f.name} className={styles.field}>
              <label htmlFor={id}>{f.label}</label>
              <input
                id={id}
                name={f.name}
                type={f.type}
                autoComplete={f.autoComplete}
                value={fields[f.name]}
                aria-invalid={error ? true : undefined}
                aria-describedby={describedBy || undefined}
                onChange={(e) => setFields({ ...fields, [f.name]: e.target.value })}
              />
              {f.hint ? (
                <span id={`${id}-hint`} className={styles.muted}>
                  {f.hint}
                </span>
              ) : null}
              {error ? (
                <span id={`${id}-error`} className={styles.error}>
                  {error}
                </span>
              ) : null}
            </div>
          )
        })}
        {serverError ? (
          <p role="alert" className={styles.error}>
            {serverError}
          </p>
        ) : null}
        <button type="submit" className={styles.submit} disabled={pending}>
          {pending ? 'Tworzenie konta…' : 'Utwórz konto właściciela'}
        </button>
      </form>
    )
  }

  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby={`${formId}-title`}>
        <p className={styles.muted}>
          {branding.productName} ({branding.nameStatus})
        </p>
        <h1 id={`${formId}-title`} className={styles.title}>
          Pierwsza konfiguracja
        </h1>
        {content}
      </section>
    </main>
  )
}
