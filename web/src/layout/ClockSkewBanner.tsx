import { sampleServerClock } from '../api/health'
import { useOptionalSession } from '../auth/SessionContext'
import { usePeriodic } from '../hooks/usePeriodic'
import { formatSkew, significantSkew } from '../lib/clockSkew'
import styles from './ClockSkewBanner.module.css'

export const CLOCK_CHECK_MS = 5 * 60_000

const browserFetch: typeof fetch = (...args) => fetch(...args)

/**
 * Ostrzeżenie o rozjechanych zegarach serwera i przeglądarki (D53), dla wszystkich ról.
 * Podaje kierunek różnicy, ale nie rozstrzyga, który zegar jest zły — z samego porównania tego
 * nie wiadomo. Najpierw radzi sprawdzić urządzenie (częstsza przyczyna, każdy może to zrobić),
 * administratorowi także serwer. Błąd sprawdzenia nie jest ostrzeżeniem o zegarze.
 */
export function ClockSkewBanner({ fetchFn = browserFetch }: { fetchFn?: typeof fetch }) {
  const { state } = usePeriodic('clock', (_now, signal) => sampleServerClock(fetchFn, signal), CLOCK_CHECK_MS)
  const session = useOptionalSession()
  if (state.status !== 'ready') return null
  const offset = significantSkew(state.data)
  if (offset === null) return null
  const admin = session?.session.memberships.some((m) => m.role === 'OWNER' || m.role === 'ADMIN') ?? false
  const direction = offset > 0 ? 'spieszy się' : 'spóźnia się'
  return (
    <div className={styles.banner} role="status">
      <p>
        Zegar serwera i tego urządzenia różnią się o {formatSkew(offset)} (serwer {direction} względem tego
        urządzenia) — wiek danych i statusy mogą być błędne.
      </p>
      <p className={styles.hint}>
        Sprawdź, czy to urządzenie ustawia czas automatycznie (z internetu).
        {admin ? (
          <>
            {' '}
            Jeśli tak, sprawdź synchronizację czasu na serwerze: <code>sudo solargraf status</code>
          </>
        ) : null}
      </p>
    </div>
  )
}
