import { BatteryCharging, Home, Sun, UtilityPole, Zap, type LucideIcon } from 'lucide-react'
import { useId } from 'react'
import { DemoBadge } from '../components/DemoBadge'
import { Panel } from '../components/Panel'
import { WidgetState } from '../components/WidgetState'
import type { LiveSite } from '../hooks/useLiveSite'
import { useNow } from '../hooks/useNow'
import { flowView, NODE_LABEL, type FlowDirection, type FlowNode, type FlowNodeKey } from '../lib/energyFlow'
import { formatQuantity, MISSING } from '../lib/format'
import { siteValue, type SiteValue } from '../lib/liveValues'
import styles from './EnergyFlowPanel.module.css'

const HUB = { x: 200, y: 130 }
const HUB_R = 26
const NODE_R = 24

const LAYOUT: Record<FlowNodeKey, { x: number; y: number; icon: LucideIcon }> = {
  pv: { x: 72, y: 40, icon: Sun },
  grid: { x: 328, y: 40, icon: UtilityPole },
  battery: { x: 72, y: 196, icon: BatteryCharging },
  home: { x: 328, y: 196, icon: Home },
}

const METRIC: Record<FlowNodeKey, string> = {
  pv: 'pv_power',
  grid: 'grid_power',
  battery: 'battery_power',
  home: 'load_power',
}

function status(v: SiteValue): string | null {
  switch (v.kind) {
    case 'value':
      return v.stale ? 'wartość nieaktualna' : null
    case 'no-data':
      return 'brak danych'
    case 'not-provided':
      return 'parametr niedostępny'
    case 'ambiguous':
      return `wiele źródeł (${v.sources})`
  }
}

/** Sieć i bateria jak na kartach: moc bez znaku, kierunek opisany słowami (D39). */
const valueText = (n: FlowNode): string => (n.value.kind === 'value' ? formatQuantity(Math.abs(n.value.value), 'W') : MISSING)

const subText = (n: FlowNode): string => [n.direction, status(n.value)].filter(Boolean).join(' · ')

/** Odcinek od krawędzi węzła do krawędzi węzła centralnego; kierunek wg przepływu. */
function segment(key: FlowNodeKey, direction: FlowDirection | undefined) {
  const { x, y } = LAYOUT[key]
  const dx = HUB.x - x
  const dy = HUB.y - y
  const len = Math.hypot(dx, dy)
  const ux = dx / len
  const uy = dy / len
  const node = { x: x + ux * (NODE_R + 4), y: y + uy * (NODE_R + 4) }
  const hub = { x: HUB.x - ux * (HUB_R + 6), y: HUB.y - uy * (HUB_R + 6) }
  const [from, to] = direction === 'out' ? [hub, node] : [node, hub]
  return { x1: from.x, y1: from.y, x2: to.x, y2: to.y }
}

function Diagram({ nodes, arrows }: { nodes: FlowNode[]; arrows: Partial<Record<FlowNodeKey, FlowDirection>> | null }) {
  const prefix = useId()
  return (
    <svg className={styles.svg} viewBox="0 0 400 280" aria-hidden="true" focusable="false">
      <defs>
        {nodes.map((n) => (
          <marker
            key={n.key}
            id={`${prefix}-arrow-${n.key}`}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" className={styles[`fill_${n.key}`]} />
          </marker>
        ))}
      </defs>
      {nodes.map((n) => {
        const direction = arrows?.[n.key]
        const active = direction === 'in' || direction === 'out'
        return (
          <line
            key={n.key}
            {...segment(n.key, direction)}
            className={active ? `${styles.link} ${styles[`stroke_${n.key}`]}` : styles.linkIdle}
            markerEnd={active ? `url(#${CSS.escape(`${prefix}-arrow-${n.key}`)})` : undefined}
          />
        )
      })}
      <circle cx={HUB.x} cy={HUB.y} r={HUB_R} className={styles.hub} />
      <Zap x={HUB.x - 12} y={HUB.y - 12} width={24} height={24} className={styles.hubIcon} />
      <text x={HUB.x} y={HUB.y + HUB_R + 17} className={styles.hubLabel}>
        Instalacja
      </text>
      {nodes.map((n) => {
        const { x, y, icon: Icon } = LAYOUT[n.key]
        const available = n.value.kind === 'value'
        return (
          <g key={n.key} className={available ? undefined : styles.unavailable}>
            <circle cx={x} cy={y} r={NODE_R} className={`${styles.node} ${styles[`stroke_${n.key}`]}`} />
            <Icon x={x - 11} y={y - 11} width={22} height={22} className={styles[`icon_${n.key}`]} />
            <text x={x} y={y + NODE_R + 17} className={styles.label}>
              {NODE_LABEL[n.key]}
            </text>
            <text x={x} y={y + NODE_R + 36} className={styles.value}>
              {valueText(n)}
            </text>
            <text x={x} y={y + NODE_R + 53} className={styles.sub}>
              {subText(n)}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

/**
 * Diagram przepływu energii (D54) z tego samego strumienia co karty (D50). Gwiazda wokół
 * instalacji, statyczne strzałki tylko przy spójnym bilansie; bez animacji.
 */
export function EnergyFlowPanel({ live, now: fixedNow }: { live: LiveSite; now?: Date }) {
  const tickingNow = useNow(1000)
  const now = fixedNow ?? tickingNow
  const { state, retry } = live

  if (state.status === 'connecting' || state.status === 'error') {
    return (
      <Panel title="Przepływ energii">
        <WidgetState status={state.status === 'connecting' ? { kind: 'loading' } : { kind: 'error', onRetry: retry }} />
      </Panel>
    )
  }

  const value = (key: FlowNodeKey): SiteValue => siteValue(state.devices, state.readings, METRIC[key], now)
  const view = flowView({ pv: value('pv'), grid: value('grid'), battery: value('battery'), home: value('home') })
  const simulated = view.nodes.some((n) => n.value.kind === 'value' && n.value.origin === 'SIMULATED')
  const notice =
    state.status === 'reconnecting' ? 'Utracono połączenie z serwerem — wartości mogą być nieaktualne.' : null

  return (
    <Panel title="Przepływ energii" actions={simulated ? <DemoBadge origin="SIMULATED" /> : null}>
      <WidgetState status={{ kind: 'ready' }} staleNotice={notice}>
        <Diagram nodes={view.nodes} arrows={view.kind === 'flows' ? view.arrows : null} />
        {view.kind === 'no-flows' ? (
          <p className={styles.reason} role="status">
            {view.reason}
          </p>
        ) : null}
        <ul className="visually-hidden" aria-label="Wartości przepływu">
          {view.nodes.map((n) => (
            <li key={n.key}>
              {NODE_LABEL[n.key]}: {valueText(n)}
              {subText(n) ? `, ${subText(n)}` : ''}
            </li>
          ))}
        </ul>
      </WidgetState>
    </Panel>
  )
}
