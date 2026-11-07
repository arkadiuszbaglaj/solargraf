import type { Unit } from '../data/types'

/** Znak wyświetlany w miejscu brakującej wartości. Nigdy „0”. */
export const MISSING = '—'

const LOCALE = 'pl-PL'

function number(value: number, fractionDigits: number): string {
  return new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value)
}

/** Jawna konwersja W → kW. */
export function wattsToKilowatts(watts: number): number {
  return watts / 1000
}

/** Jawna konwersja Wh → kWh. */
export function wattHoursToKilowattHours(wattHours: number): number {
  return wattHours / 1000
}

/**
 * Formatuje wartość w jednostce kanonicznej do prezentacji.
 * W → kW (2 miejsca), Wh → kWh (1 miejsce); pozostałe jednostki bez konwersji.
 */
export function formatQuantity(value: number | null, unit: Unit): string {
  if (value === null || !Number.isFinite(value)) {
    return MISSING
  }
  switch (unit) {
    case 'W':
      return `${number(wattsToKilowatts(value), 2)} kW`
    case 'Wh':
      return `${number(wattHoursToKilowattHours(value), 1)} kWh`
    case '%':
      return `${number(value, 0)}%`
    case 'V':
      return `${number(value, 1)} V`
    case 'A':
      return `${number(value, 1)} A`
    case '°C':
      return `${number(value, 1)} °C`
    case 'Hz':
      return `${number(value, 2)} Hz`
  }
}

/** Wartość bezwzględna mocy z opisem kierunku według konwencji znaku. */
export function formatDirectedPower(
  watts: number | null,
  positiveLabel: string,
  negativeLabel: string,
): { text: string; direction: string | null } {
  if (watts === null || !Number.isFinite(watts)) {
    return { text: MISSING, direction: null }
  }
  const direction = watts > 0 ? positiveLabel : watts < 0 ? negativeLabel : 'brak przepływu'
  return { text: formatQuantity(Math.abs(watts), 'W'), direction }
}

/** Czas lokalny instalacji, np. „07.11.2026, 13:05”. */
export function formatDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))
}

export function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone, hour: '2-digit', minute: '2-digit' }).format(
    new Date(iso),
  )
}

/** Wiek wartości w czytelnej postaci, np. „12 s”, „5 min”, „3 h”. */
export function formatAge(seconds: number): string {
  if (seconds < 60) {
    return `${Math.max(0, Math.floor(seconds))} s`
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)} min`
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)} h`
  }
  return `${Math.floor(seconds / 86400)} d`
}
