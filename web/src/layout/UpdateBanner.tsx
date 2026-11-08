import { useState } from 'react'
import { dismissUpdate, getUpdates } from '../api/updates'
import type { UpdatesState } from '../api/updates'
import { useOptionalSession } from '../auth/SessionContext'
import { usePeriodic } from '../hooks/usePeriodic'
import { isPostponed, postpone } from '../lib/updates'
import { SERVER_HEALTH_PATH } from '../paths'
import styles from './UpdateBanner.module.css'

/** Stan zmienia worker najwyżej raz na dobę. */
export const UPDATE_BANNER_REFRESH_MS = 60 * 60_000

const browserFetch: typeof fetch = (...args) => fetch(...args)

/** Ładuje stan tylko dla właściciela — inne role dostałyby 403 (D63). */
export function UpdateBanner({ fetchFn = browserFetch }: { fetchFn?: typeof fetch }) {
  const session = useOptionalSession()
  const isOwner = session?.session.memberships.some((m) => m.role === 'OWNER') ?? false
  if (session === null || !isOwner) return null
  return <OwnerUpdateBanner fetchFn={fetchFn} csrfToken={session.session.csrfToken} />
}

function OwnerUpdateBanner({ fetchFn, csrfToken }: { fetchFn: typeof fetch; csrfToken: string }) {
  const { state, reload } = usePeriodic<UpdatesState | null>(
    'update-banner',
    async (_now, signal) => {
      const result = await getUpdates(fetchFn, signal)
      // Błąd pobrania stanu nie jest komunikatem o wersji — baner po prostu się nie pojawia.
      return result.kind === 'ok' ? result.data : null
    },
    UPDATE_BANNER_REFRESH_MS,
  )
  const [hidden, setHidden] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (state.status !== 'ready' || state.data === null) return null
  const a = state.data.available
  if (a === null || state.data.dismissed || hidden === a.version) return null
  if (a.security && isPostponed(a.version)) return null

  const dismiss = async () => {
    setBusy(true)
    setError(null)
    const result = await dismissUpdate(a.version, csrfToken, fetchFn)
    setBusy(false)
    if (result.ok) {
      setHidden(a.version)
      reload()
    } else {
      setError(result.message)
    }
  }
  const later = () => {
    postpone(a.version)
    setHidden(a.version)
  }

  return (
    <div className={`${styles.banner} ${a.security ? styles.security : ''}`} role="status">
      <p>
        <strong>
          Dostępna jest wersja {a.version}
          {a.security ? ' z poprawkami bezpieczeństwa' : ''}.
        </strong>{' '}
        Zainstalowana: {state.data.currentVersion}. <a href={SERVER_HEALTH_PATH}>Szczegóły i instrukcja</a>
      </p>
      <div className={styles.actions}>
        {a.security ? (
          <button type="button" className={styles.button} onClick={later}>
            Przypomnij przy następnym logowaniu
          </button>
        ) : (
          <button type="button" className={styles.button} disabled={busy} onClick={() => void dismiss()}>
            Nie pokazuj dla tej wersji
          </button>
        )}
      </div>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
    </div>
  )
}
