/** Czas serwera z `GET /api/health` (D25, D53) — bez uwierzytelnienia. */
import type { ClockSample } from '../lib/clockSkew'

export function parseServerTime(body: unknown): Date | null {
  if (typeof body !== 'object' || body === null) return null
  const value = (body as Record<string, unknown>).server_time
  if (typeof value !== 'string') return null
  const time = new Date(value)
  return Number.isNaN(time.getTime()) ? null : time
}

/** Jedno porównanie zegarów; błąd sieci lub niepoprawna odpowiedź → wyjątek (brak ostrzeżenia). */
export async function sampleServerClock(
  fetchFn: typeof fetch,
  signal: AbortSignal,
  clock: () => Date = () => new Date(),
): Promise<ClockSample> {
  const sentAt = clock()
  const response = await fetchFn('/api/health', { signal, cache: 'no-store' })
  const receivedAt = clock()
  if (!response.ok) throw new Error('health')
  const serverTime = parseServerTime(await response.json())
  if (!serverTime) throw new Error('health')
  return { serverTime, sentAt, receivedAt }
}
