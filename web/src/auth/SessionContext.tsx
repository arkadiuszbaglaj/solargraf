import type { ReactNode } from 'react'
import { createContext, useContext } from 'react'
import type { Session } from '../api/auth'

export interface SessionValue {
  session: Session
  logout: () => void
  loggingOut: boolean
}

const SessionContext = createContext<SessionValue | null>(null)

export function SessionProvider({ value, children }: { value: SessionValue; children: ReactNode }) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

/** Sesja, gdy UI działa za bramką logowania; `null` w testach i trybie dev bez API. */
export function useOptionalSession(): SessionValue | null {
  return useContext(SessionContext)
}
