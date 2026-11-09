import { useEffect, useRef } from 'react'
import { LineChart } from 'echarts/charts'
import {
  AriaComponent,
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  GridComponent,
  LegendComponent,
  ToolboxComponent,
  TooltipComponent,
} from 'echarts/components'
import * as echarts from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'
import { type Zoom, isFullZoom, normalizeZoom } from '../lib/chartZoom'
import type { LoadedSeries } from '../lib/siteHistory'
import { buildSiteHistoryOption, type SiteChartColors, zoomAxisLabel } from './siteHistoryOption'
import styles from './SiteHistoryChartView.module.css'

echarts.use([
  LineChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  AriaComponent,
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  ToolboxComponent,
  SVGRenderer,
])

function readColors(el: HTMLElement): SiteChartColors {
  const css = getComputedStyle(el)
  const v = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback
  return {
    series: {
      pv: v('--chart-pv', '#2e9e5b'),
      home: v('--chart-home', '#3b4a42'),
      grid: v('--chart-grid', '#2f80c7'),
      battery: v('--chart-battery', '#7556c2'),
    },
    text: v('--color-text-muted', '#56635c'),
    border: v('--color-border', '#dfe6e2'),
    accent: v('--color-accent', '#1f7a45'),
  }
}

/** Okno przybliżenia odczytane z ECharts (pierwszy dataZoom — wszystkie dotyczą tej samej osi). */
function currentZoom(instance: echarts.ECharts): Zoom | null {
  const option = instance.getOption() as { dataZoom?: Array<{ start?: unknown; end?: unknown }> }
  const dz = option.dataZoom?.[0]
  if (typeof dz?.start !== 'number' || typeof dz.end !== 'number') return null
  return normalizeZoom({ start: dz.start, end: dz.end })
}

/**
 * Włącza zaznaczanie fragmentu przeciągnięciem (narzędzie dataZoom paska narzędzi, bez ikon).
 * Tylko przy myszy — na ekranie dotykowym przeciąganie po wykresie przewija stronę; zostają suwak
 * i przyciski.
 */
function enableSelect(instance: echarts.ECharts) {
  if (typeof window.matchMedia !== 'function' || !window.matchMedia('(pointer: fine)').matches) return
  instance.dispatchAction({ type: 'takeGlobalCursor', key: 'dataZoomSelect', dataZoomSelectActive: true })
}

/**
 * Wrapper ECharts dla serii instalacji (D66): inicjalizacja, opcje, resize, sprzątanie.
 * Przybliżenie jest sterowane z zewnątrz (`zoom`) — kilka wykresów strony pokazuje ten sam fragment;
 * zmiana myszą (zaznaczenie, suwak, Ctrl + kółko) wraca przez `onZoom`.
 */
export function SiteHistoryChartView({
  series,
  timeZone,
  range,
  label,
  zoom,
  onZoom,
  slider = true,
}: {
  series: readonly LoadedSeries[]
  timeZone: string
  range: { from: Date; to: Date }
  label: string
  zoom: Zoom
  onZoom: (zoom: Zoom) => void
  /** Suwak czasu pod wykresem; drugi wykres strony może go pominąć. */
  slider?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const instanceRef = useRef<echarts.ECharts | null>(null)
  // Najnowsze wartości dla obsługi zdarzeń bez ponownej inicjalizacji wykresu.
  const zoomRef = useRef(zoom)
  const onZoomRef = useRef(onZoom)
  useEffect(() => {
    zoomRef.current = zoom
    onZoomRef.current = onZoom
  })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const instance = echarts.init(el, undefined, { renderer: 'svg' })
    instanceRef.current = instance
    instance.setOption(buildSiteHistoryOption(series, readColors(el), timeZone, range, zoomRef.current, slider))
    enableSelect(instance)
    instance.on('datazoom', () => {
      const next = currentZoom(instance)
      if (!next) return
      instance.setOption({ xAxis: { axisLabel: { formatter: zoomAxisLabel(range, next, timeZone) } } })
      // Zaznaczanie zostaje aktywne po każdym przybliżeniu.
      enableSelect(instance)
      const prev = zoomRef.current
      if (next.start !== prev.start || next.end !== prev.end) onZoomRef.current(next)
    })
    const observer = new ResizeObserver(() => instance.resize())
    observer.observe(el)
    return () => {
      observer.disconnect()
      instanceRef.current = null
      instance.dispose()
    }
  }, [series, timeZone, range, slider])

  // Zmiana z przycisków albo z drugiego wykresu — `setOption` nie wywołuje zdarzenia `datazoom`.
  useEffect(() => {
    const instance = instanceRef.current
    if (!instance) return
    const shown = currentZoom(instance)
    if (shown && shown.start === zoom.start && shown.end === zoom.end) return
    const window = { start: zoom.start, end: zoom.end }
    instance.setOption({
      dataZoom: slider ? [window, window] : [window],
      xAxis: { axisLabel: { formatter: zoomAxisLabel(range, zoom, timeZone) } },
    })
  }, [zoom, range, timeZone, slider])

  return (
    <div
      ref={ref}
      className={styles.chart}
      role="img"
      aria-label={isFullZoom(zoom) ? label : `${label} Widok przybliżony.`}
    />
  )
}
