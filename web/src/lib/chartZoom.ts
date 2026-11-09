/**
 * Przybliżenie osi czasu wykresów instalacji: widoczne okno jako procent zakresu (0–100),
 * jak `start`/`end` w dataZoom ECharts. Te same funkcje obsługują przyciski (klawiatura)
 * i podpis widocznego zakresu. Dane się nie zmieniają — to tylko widok.
 */

export interface Zoom {
  start: number
  end: number
}

export const FULL_ZOOM: Zoom = { start: 0, end: 100 }

/** Najwęższe okno z przycisku „Przybliż” — 1% zakresu (dla dnia ok. 15 min). */
export const MIN_ZOOM_WIDTH = 1

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const round = (v: number) => Math.round(v * 1000) / 1000

/** Poprawne okno: 0 ≤ start < end ≤ 100; zaokrąglenie usuwa szum liczb z ECharts. */
export function normalizeZoom(z: Zoom): Zoom {
  const start = clamp(round(z.start), 0, 100)
  const end = clamp(round(z.end), 0, 100)
  return end > start ? { start, end } : FULL_ZOOM
}

export const isFullZoom = (z: Zoom): boolean => z.start <= 0 && z.end >= 100

/** Okno o szerokości `width` wokół środka `center`, przesunięte, by mieściło się w 0–100. */
function around(center: number, width: number): Zoom {
  const w = clamp(width, MIN_ZOOM_WIDTH, 100)
  const start = clamp(center - w / 2, 0, 100 - w)
  return normalizeZoom({ start, end: start + w })
}

export const zoomIn = (z: Zoom): Zoom => around((z.start + z.end) / 2, (z.end - z.start) / 2)

export const zoomOut = (z: Zoom): Zoom => around((z.start + z.end) / 2, (z.end - z.start) * 2)

/** Przesunięcie o pół okna wcześniej (−1) albo później (+1). */
export function panZoom(z: Zoom, direction: -1 | 1): Zoom {
  const w = z.end - z.start
  return around((z.start + z.end) / 2 + (direction * w) / 2, w)
}

/** Widoczny fragment zakresu czasu dla okna przybliżenia. */
export function visibleRange(range: { from: Date; to: Date }, z: Zoom): { from: Date; to: Date } {
  const from = range.from.getTime()
  const span = range.to.getTime() - from
  return { from: new Date(from + (span * z.start) / 100), to: new Date(from + (span * z.end) / 100) }
}
