/** Przesunięcie strefy względem UTC w danej chwili, w minutach (np. +60 dla CET). */
export function timeZoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant)
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value)
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  )
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000)
}

/** Data lokalna (YYYY-MM-DD) w strefie instalacji. */
export function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant)
}

/**
 * Początek doby lokalnej (00:00 w strefie instalacji) jako chwila UTC.
 * Uwzględnia zmianę czasu: przesunięcie liczone jest dla północy, nie dla „teraz”.
 */
export function startOfLocalDay(instant: Date, timeZone: string): Date {
  const [y, m, d] = localDate(instant, timeZone).split('-').map(Number) as [number, number, number]
  const naiveUtc = Date.UTC(y, m - 1, d)
  let guess = naiveUtc - timeZoneOffsetMinutes(new Date(naiveUtc), timeZone) * 60000
  // Druga iteracja koryguje przypadek, gdy przesunięcie w chwili zgadywanej jest inne.
  guess = naiveUtc - timeZoneOffsetMinutes(new Date(guess), timeZone) * 60000
  return new Date(guess)
}
