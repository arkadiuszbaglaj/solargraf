import { useEffect, useState } from 'react'
import {
  browserLiveSource,
  CLOSED,
  liveUrl,
  parseReadings,
  parseSnapshot,
  type LiveDevice,
  type LiveEventSource,
  type LiveSourceFactory,
} from '../api/live'
import { mergeReadings, type ReadingMap } from '../lib/liveValues'

export type LiveState =
  | { status: 'connecting' }
  | { status: 'error' }
  | {
      status: 'live' | 'reconnecting'
      devices: LiveDevice[]
      readings: ReadingMap
    }

/** Po zamknięciu strumienia (np. API niedostępne, 502 z proxy) nowa próba po tym czasie. */
export const RECONNECT_MS = 10_000

/**
 * Subskrypcja strumienia na żywo instalacji (D50). Przy zerwaniu EventSource łączy się sam; gdy
 * przeglądarka zamknie strumień (odpowiedź inna niż SSE), hook otwiera nowy po `RECONNECT_MS`.
 * W tym czasie dane zostają, a ich wiek rośnie (karty przechodzą w stan nieaktualny). Bez danych
 * pokazuje błąd z możliwością natychmiastowego ponowienia.
 */
export function useLiveSite(
  siteId: string,
  factory: LiveSourceFactory = browserLiveSource,
): { state: LiveState; retry: () => void } {
  const [attempt, setAttempt] = useState(0)
  // Stan należy do konkretnego połączenia; nowa instalacja albo ponowienie zaczyna od „connecting”.
  const key = `${siteId}#${attempt}`
  const [current, setCurrent] = useState<{ key: string; state: LiveState } | null>(null)

  useEffect(() => {
    const setState = (next: LiveState | ((s: LiveState) => LiveState)): void =>
      setCurrent((c) => {
        const prev = c?.key === key ? c.state : { status: 'connecting' as const }
        return { key, state: typeof next === 'function' ? next(prev) : next }
      })
    let source: LiveEventSource | null = null
    let timer: ReturnType<typeof setTimeout> | undefined

    const connect = (): void => {
      const opened = factory(liveUrl(siteId))
      source = opened
      opened.addEventListener('snapshot', (event) => {
        const snapshot = parseSnapshot(event.data)
        if (!snapshot) return
        setState({
          status: 'live',
          devices: snapshot.devices,
          readings: mergeReadings(new Map(), snapshot.readings),
        })
      })
      opened.addEventListener('readings', (event) => {
        const readings = parseReadings(event.data)
        if (!readings) return
        setState((s) =>
          s.status === 'live' || s.status === 'reconnecting'
            ? { ...s, readings: mergeReadings(s.readings, readings) }
            : s,
        )
      })
      opened.addEventListener('error', () => {
        if (opened.readyState === CLOSED) {
          opened.close()
          timer = setTimeout(connect, RECONNECT_MS)
        }
        setState((s) =>
          s.status === 'live' || s.status === 'reconnecting'
            ? { ...s, status: 'reconnecting' }
            : opened.readyState === CLOSED
              ? { status: 'error' }
              : s,
        )
      })
    }

    connect()
    return () => {
      clearTimeout(timer)
      source?.close()
    }
  }, [key, siteId, factory])

  const state: LiveState = current?.key === key ? current.state : { status: 'connecting' }
  return { state, retry: () => setAttempt((a) => a + 1) }
}
