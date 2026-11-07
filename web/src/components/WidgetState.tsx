import type { ReactNode } from 'react'
import styles from './WidgetState.module.css'

export type WidgetStatus =
  | { kind: 'loading' }
  | { kind: 'error'; onRetry?: () => void }
  | { kind: 'empty'; message: string }
  | { kind: 'ready' }

/**
 * Wspólna obsługa stanów widżetu: ładowanie, błąd, brak danych, dane.
 * Stan „nieaktualne” nie zastępuje treści — pokazuje ją z ostrzeżeniem (`staleNotice`).
 */
export function WidgetState({
  status,
  staleNotice,
  children,
}: {
  status: WidgetStatus
  staleNotice?: string | null
  children?: ReactNode
}) {
  switch (status.kind) {
    case 'loading':
      return (
        <div className={styles.placeholder} role="status" aria-live="polite">
          Ładowanie…
        </div>
      )
    case 'error':
      return (
        <div className={`${styles.placeholder} ${styles.error}`} role="alert">
          <p>Nie udało się pobrać danych.</p>
          {status.onRetry ? (
            <button type="button" className={styles.retry} onClick={status.onRetry}>
              Spróbuj ponownie
            </button>
          ) : null}
        </div>
      )
    case 'empty':
      return <div className={styles.placeholder}>{status.message}</div>
    case 'ready':
      return (
        <>
          {staleNotice ? (
            <p className={styles.stale} role="status">
              {staleNotice}
            </p>
          ) : null}
          {children}
        </>
      )
  }
}
