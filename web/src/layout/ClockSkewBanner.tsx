import { sampleServerClock } from '../api/health'
import { useOptionalSession } from '../auth/SessionContext'
import { usePeriodic } from '../hooks/usePeriodic'
import { formatSkew, significantSkew } from '../lib/clockSkew'
import styles from './ClockSkewBanner.module.css'

export const CLOCK_CHECK_MS = 5 * 60_000

const browserFetch: typeof fetch = (...args) => fetch(...args)

/**
 * Ostrzeżenie o rozjechanych zegarach serwera i przeglądarki (D53), dla wszystkich ról.
 * Nie wskazuje, który zegar jest zły — z samego porównania tego nie wiadomo. Błąd sprawdzenia
 * nie jest ostrzeżeniem o zegarze (dostępność API pokazują widżety).
 */
export function ClockSkewBanner({ fetchFn = browserFetch }: { fetchFn?: typeof fetch }) {
  const { state } = usePeriodic('clock', (_now, signal) => sampleServerClock(fetchFn, signal), CLOCK_CHECK_MS)
  const session = useOptionalSession()
  if (state.status !== 'ready') return null
  const offset = significantSkew(state.data)
  if (offset === null) return null
  const admin = session?.session.memberships.some((m) => m.role === 'OWNER' || m.role === 'ADMIN') ?? false
  return (
    <div className={styles.banner} role="status">
      <p>
        Zegar serwera i tego urządzenia różnią się o {formatSkew(offset)} — wiek danych i statusy mogą być
        błędne.
      </p>
      {admin ? (
        <p className={styles.hint}>
          Sprawdź synchronizację czasu na serwerze: <code>sudo solargraf status</code>
        </p>
      ) : null}
    </div>
  )
}
