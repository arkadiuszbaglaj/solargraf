import type { ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { Session, SessionResult } from '../api/auth'
import { assignLocation, getSession, loginUrl, logout as postLogout } from '../api/auth'
import { WidgetState } from '../components/WidgetState'
import { SessionProvider } from './SessionContext'

/** Co ile sprawdzamy, czy sesja nadal jest ważna (24 h bezczynności, 14 dni bezwzględnie — D30). */
export const SESSION_CHECK_MS = 5 * 60 * 1000

type GateState = { kind: 'loading' } | { kind: 'error' } | { kind: 'ok'; session: Session }

/** Cały interfejs poza /login i /setup wymaga sesji (decyzja 2026-11-07). */
export function AuthGate({
  children,
  fetchFn = fetch,
  navigate = assignLocation,
}: {
  children: ReactNode
  fetchFn?: typeof fetch
  navigate?: (url: string) => void
}) {
  const [state, setState] = useState<GateState>({ kind: 'loading' })
  const [loggingOut, setLoggingOut] = useState(false)

  const apply = useCallback(
    (result: SessionResult, firstLoad: boolean) => {
      if (result.kind === 'ok') {
        setState({ kind: 'ok', session: result.session })
      } else if (result.kind === 'anonymous') {
        navigate(loginUrl(firstLoad ? undefined : 'expired'))
      } else if (firstLoad) {
        setState({ kind: 'error' })
      }
      // Błąd sieci przy kontroli okresowej nie wylogowuje — następna kontrola spróbuje ponownie.
    },
    [navigate],
  )

  useEffect(() => {
    const controller = new AbortController()
    getSession(fetchFn, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) apply(result, true)
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [fetchFn, apply])

  const authenticated = state.kind === 'ok'
  useEffect(() => {
    if (!authenticated) return undefined
    const recheck = () => {
      getSession(fetchFn)
        .then((result) => apply(result, false))
        .catch(() => undefined)
    }
    const timer = window.setInterval(recheck, SESSION_CHECK_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') recheck()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [authenticated, fetchFn, apply])

  if (state.kind === 'loading') {
    return (
      <main id="main">
        <WidgetState status={{ kind: 'loading' }} />
      </main>
    )
  }
  if (state.kind === 'error') {
    const retry = () => {
      setState({ kind: 'loading' })
      getSession(fetchFn)
        .then((result) => apply(result, true))
        .catch(() => undefined)
    }
    return (
      <main id="main">
        <WidgetState status={{ kind: 'error', onRetry: retry }} />
      </main>
    )
  }

  const session = state.session
  const logout = () => {
    setLoggingOut(true)
    void postLogout(session.csrfToken, fetchFn).then(() => navigate('/login'))
  }
  return <SessionProvider value={{ session, logout, loggingOut }}>{children}</SessionProvider>
}
