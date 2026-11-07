import { useEffect, useState } from 'react'

export const REFRESH_MS = 5 * 60_000

export type PeriodicState<T> =
  | { status: 'loading' }
  | { status: 'error' }
  /** `failed` — ostatnie odświeżenie się nie udało; dane pochodzą z wcześniejszego pobrania. */
  | { status: 'ready'; data: T; failed: boolean }

/**
 * Pobiera dane i odświeża je co `intervalMs` oraz po powrocie do karty przeglądarki (D51).
 * Przy odświeżaniu zostawia poprzednie dane (bez migania „Ładowanie…”). Zmiana `key` zaczyna
 * od nowa. `load` dostaje chwilę pobrania — np. do wyznaczenia dzisiejszej doby lokalnej.
 */
export function usePeriodic<T>(
  key: string,
  load: (now: Date, signal: AbortSignal) => Promise<T>,
  intervalMs = REFRESH_MS,
): { state: PeriodicState<T>; reload: () => void } {
  const [tick, setTick] = useState(0)
  const [current, setCurrent] = useState<{ key: string; state: PeriodicState<T> } | null>(null)

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), intervalMs)
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') setTick((t) => t + 1)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [intervalMs])

  useEffect(() => {
    const controller = new AbortController()
    load(new Date(), controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setCurrent({ key, state: { status: 'ready', data, failed: false } })
      },
      () => {
        if (controller.signal.aborted) return
        setCurrent((c) =>
          c?.key === key && c.state.status === 'ready'
            ? { key, state: { ...c.state, failed: true } }
            : { key, state: { status: 'error' } },
        )
      },
    )
    return () => controller.abort()
    // `load` celowo poza zależnościami: odświeżanie wyznacza `key` i `tick`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick])

  const state: PeriodicState<T> = current?.key === key ? current.state : { status: 'loading' }
  return { state, reload: () => setTick((t) => t + 1) }
}
