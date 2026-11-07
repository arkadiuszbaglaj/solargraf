import { useCallback, useEffect, useState } from 'react'

export type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: T }

/**
 * Pobiera dane i przerywa poprzednie żądanie przy zmianie zależności lub odmontowaniu.
 * Szczegóły błędu nie trafiają do UI (CLAUDE.md: nie ujawniamy szczegółów urządzeń).
 */
export function useAsync<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): { state: AsyncState<T>; reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })
    load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ status: 'ready', data })
      },
      () => {
        if (!controller.signal.aborted) setState({ status: 'error' })
      },
    )
    return () => controller.abort()
    // eslint-style: zależności podaje wywołujący.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [...deps, attempt])

  const reload = useCallback(() => setAttempt((n) => n + 1), [])
  return { state, reload }
}
