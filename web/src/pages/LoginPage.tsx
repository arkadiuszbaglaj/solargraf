import type { FormEvent } from 'react'
import { useId, useState } from 'react'
import { assignLocation, login as postLogin, safeNext } from '../api/auth'
import { branding } from '../branding'
import styles from './AuthPage.module.css'

export function LoginPage({
  initialEmail = '',
  next = '/',
  expired = false,
  submit = postLogin,
  navigate = assignLocation,
}: {
  initialEmail?: string
  next?: string
  expired?: boolean
  submit?: typeof postLogin
  navigate?: (url: string) => void
}) {
  const id = useId()
  const [email, setEmail] = useState(initialEmail)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!email.trim() || !password) {
      setError('Podaj e-mail i hasło.')
      return
    }
    setError(null)
    setPending(true)
    const result = await submit(email.trim(), password)
    setPending(false)
    if (result.ok) {
      setPassword('')
      navigate(safeNext(next))
    } else {
      setPassword('')
      setError(result.message)
    }
  }

  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby={`${id}-title`}>
        <p className={styles.muted}>
          {branding.productName} ({branding.nameStatus})
        </p>
        <h1 id={`${id}-title`} className={styles.title}>
          Logowanie
        </h1>
        {expired ? (
          <p role="status" className={styles.muted}>
            Sesja wygasła. Zaloguj się ponownie.
          </p>
        ) : null}
        <form className={styles.form} onSubmit={(e) => void onSubmit(e)} noValidate>
          <div className={styles.field}>
            <label htmlFor={`${id}-email`}>E-mail</label>
            <input
              id={`${id}-email`}
              name="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor={`${id}-password`}>Hasło</label>
            <input
              id={`${id}-password`}
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error ? (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          ) : null}
          <button type="submit" className={styles.submit} disabled={pending}>
            {pending ? 'Logowanie…' : 'Zaloguj się'}
          </button>
        </form>
      </section>
    </main>
  )
}
