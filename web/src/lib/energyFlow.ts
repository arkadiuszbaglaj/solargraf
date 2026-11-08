/**
 * Przepływ energii instalacji (D54) z wartości na żywo (D50). Czyste funkcje — bez UI i zegara.
 *
 * Topologia gwiazdy: każdy węzeł (PV, sieć, bateria, dom) wymienia moc z instalacją (węzłem
 * centralnym). Nie rozdzielamy, która energia płynie dokąd (np. PV → bateria) — pomiary tego nie
 * potwierdzają. Strzałki pokazujemy tylko przy spójnym bilansie świeżych, prawie równoczesnych
 * odczytów; rozbieżności nie są ukrywane ani korygowane.
 *
 * Znak D39: sieć + pobór / − oddawanie, bateria + rozładowanie / − ładowanie.
 */
import { formatQuantity } from './format'
import type { SiteValue } from './liveValues'

/** Poniżej tej mocy węzeł nie ma strzałki („brak przepływu”); wartość liczbowa zostaje. */
export const IDLE_W = 50
/** Największa różnica czasu odebrania odczytów, przy której bilans ma sens. */
export const MAX_SPREAD_S = 30
/** Tolerancja bilansu: max(150 W, 10% większej strony) — straty falownika i niesynchroniczność. */
export const BALANCE_MIN_W = 150
export const BALANCE_RATIO = 0.1

export type FlowNodeKey = 'pv' | 'grid' | 'battery' | 'home'

/** Kierunek względem instalacji: `in` — węzeł oddaje moc do instalacji, `out` — pobiera. */
export type FlowDirection = 'in' | 'out' | 'idle'

export const NODE_LABEL: Record<FlowNodeKey, string> = {
  pv: 'Produkcja PV',
  grid: 'Sieć',
  battery: 'Magazyn energii',
  home: 'Zużycie domu',
}

export interface FlowInputs {
  pv: SiteValue
  grid: SiteValue
  battery: SiteValue
  home: SiteValue
}

export interface FlowNode {
  key: FlowNodeKey
  value: SiteValue
  /** Opis kierunku dla wartości liczbowej, np. „oddawanie do sieci”; null bez wartości. */
  direction: string | null
}

export type FlowView =
  | { kind: 'flows'; nodes: FlowNode[]; arrows: Partial<Record<FlowNodeKey, FlowDirection>> }
  | { kind: 'no-flows'; nodes: FlowNode[]; reason: string }

const fresh = (v: SiteValue): v is Extract<SiteValue, { kind: 'value' }> => v.kind === 'value' && !v.stale

/** Moc dopływająca do instalacji z węzła (dom pobiera, więc ma znak przeciwny). */
const inflow = (key: FlowNodeKey, watts: number): number => (key === 'home' ? -watts : watts)

export function flowDirection(key: FlowNodeKey, watts: number): FlowDirection {
  if (Math.abs(watts) < IDLE_W) return 'idle'
  return inflow(key, watts) > 0 ? 'in' : 'out'
}

function describe(key: FlowNodeKey, v: SiteValue): string | null {
  if (v.kind !== 'value') return null
  if (Math.abs(v.value) < IDLE_W) return 'brak przepływu'
  switch (key) {
    case 'grid':
      return v.value > 0 ? 'pobór z sieci' : 'oddawanie do sieci'
    case 'battery':
      return v.value > 0 ? 'rozładowanie' : 'ładowanie'
    case 'pv':
      return v.value > 0 ? 'produkcja' : null
    case 'home':
      return 'zużycie'
  }
}

/** Moc, od której animacja ma największą prędkość i grubość. */
export const MOTION_MAX_W = 10_000
/** Czas przejścia jednego okresu kropek: przy IDLE_W (wolno) i przy MOTION_MAX_W (szybko). */
export const MOTION_SLOW_S = 3
export const MOTION_FAST_S = 0.6
/** Średnica kropek w jednostkach SVG: przy IDLE_W i przy MOTION_MAX_W. */
export const MOTION_THIN = 4
export const MOTION_THICK = 8

export interface FlowMotion {
  /** Czas jednego okresu animacji w sekundach (krótszy = szybszy ruch). */
  durationS: number
  /** Grubość (średnica kropek) w jednostkach SVG. */
  width: number
}

/**
 * Prędkość i grubość animacji przepływu z mocy w W (D64). Skala logarytmiczna od IDLE_W do
 * MOTION_MAX_W, powyżej — nasycenie. Poniżej IDLE_W albo dla wartości nieskończonej — null (bez
 * ruchu). Wynik zaokrąglony, żeby drobne wahania mocy nie zmieniały animacji co sekundę.
 */
export function flowMotion(watts: number): FlowMotion | null {
  const w = Math.abs(watts)
  if (!Number.isFinite(w) || w < IDLE_W) return null
  const t = Math.min(1, Math.log(w / IDLE_W) / Math.log(MOTION_MAX_W / IDLE_W))
  return {
    durationS: Math.round((MOTION_SLOW_S + (MOTION_FAST_S - MOTION_SLOW_S) * t) * 10) / 10,
    width: Math.round((MOTION_THIN + (MOTION_THICK - MOTION_THIN) * t) * 2) / 2,
  }
}

/**
 * Bilans mocy: suma dopływów do instalacji (dodatnia oznacza nadwyżkę źródeł nad odbiorami).
 * Zwraca różnicę i tolerancję w W.
 */
export function balance(watts: Partial<Record<FlowNodeKey, number>>): { residual: number; tolerance: number } {
  let supply = 0
  let demand = 0
  for (const [key, w] of Object.entries(watts) as [FlowNodeKey, number][]) {
    const f = inflow(key, w)
    if (f > 0) supply += f
    else demand -= f
  }
  return {
    residual: supply - demand,
    tolerance: Math.max(BALANCE_MIN_W, BALANCE_RATIO * Math.max(supply, demand)),
  }
}

/**
 * Widok diagramu. Bateria jest widoczna tylko, gdy instalacja ma jej źródło; PV, sieć i dom
 * zawsze (bez źródła — „parametr niedostępny”).
 */
export function flowView(inputs: FlowInputs): FlowView {
  const keys: FlowNodeKey[] = ['pv', 'grid', ...(inputs.battery.kind === 'not-provided' ? [] : ['battery' as const]), 'home']
  const nodes = keys.map((key) => ({ key, value: inputs[key], direction: describe(key, inputs[key]) }))

  const missing = nodes.filter((n) => !fresh(n.value)).map((n) => NODE_LABEL[n.key])
  if (missing.length > 0) {
    return { kind: 'no-flows', nodes, reason: `Przepływy nie są pokazywane — brak świeżych danych: ${missing.join(', ')}.` }
  }
  const values = nodes.map((n) => n.value as Extract<SiteValue, { kind: 'value' }>)
  const ages = values.map((v) => v.ageSeconds)
  const spread = Math.max(...ages) - Math.min(...ages)
  if (spread > MAX_SPREAD_S) {
    return {
      kind: 'no-flows',
      nodes,
      reason: `Przepływy nie są pokazywane — odczyty z różnych chwil (różnica ${Math.round(spread)} s).`,
    }
  }
  const watts = Object.fromEntries(nodes.map((n, i) => [n.key, values[i]?.value ?? 0])) as Partial<
    Record<FlowNodeKey, number>
  >
  const { residual, tolerance } = balance(watts)
  if (Math.abs(residual) > tolerance) {
    return {
      kind: 'no-flows',
      nodes,
      reason: `Bilans się nie domyka (różnica ${formatQuantity(Math.abs(residual), 'W')}) — przepływy nie są pokazywane.`,
    }
  }
  const arrows: Partial<Record<FlowNodeKey, FlowDirection>> = {}
  for (const n of nodes) arrows[n.key] = flowDirection(n.key, watts[n.key] ?? 0)
  return { kind: 'flows', nodes, arrows }
}
