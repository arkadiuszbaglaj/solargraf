/**
 * Różnica między zegarem serwera a zegarem przeglądarki (D53). Tylko ostrzeżenie — UI nie
 * koryguje wieku danych, bo to ukryłoby problem (znaczniki czasu w bazie i tak są złe).
 */

/** Powyżej tej różnicy (po odjęciu niepewności pomiaru) UI pokazuje ostrzeżenie. */
export const SKEW_THRESHOLD_S = 60

export interface ClockSample {
  /** Czas serwera z odpowiedzi `/api/health`. */
  serverTime: Date
  /** Zegar przeglądarki przy wysłaniu i odebraniu zapytania. */
  sentAt: Date
  receivedAt: Date
}

/**
 * Przesunięcie zegara serwera względem przeglądarki w sekundach (dodatnie — serwer się spieszy)
 * albo `null`, gdy różnica mieści się w progu. Serwer odczytał czas gdzieś między wysłaniem
 * a odebraniem, więc połowa czasu odpowiedzi to niepewność pomiaru.
 */
export function significantSkew(sample: ClockSample, thresholdS = SKEW_THRESHOLD_S): number | null {
  const sent = sample.sentAt.getTime()
  const received = sample.receivedAt.getTime()
  const uncertaintyS = Math.max(0, received - sent) / 2000
  const offsetS = (sample.serverTime.getTime() - (sent + received) / 2) / 1000
  return Math.abs(offsetS) - uncertaintyS > thresholdS ? offsetS : null
}

/** „2 h 13 min”, „5 min”, „3 d 4 h” — wielkość różnicy bez znaku. */
export function formatSkew(offsetS: number): string {
  const minutes = Math.floor(Math.abs(offsetS) / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`
  const days = Math.floor(hours / 24)
  return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`
}
