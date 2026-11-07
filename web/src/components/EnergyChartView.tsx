import { useEffect, useRef } from 'react'
import { LineChart } from 'echarts/charts'
import {
  AriaComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components'
import * as echarts from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'
import type { EnergyChart } from '../data/types'
import { buildChartOption, type ChartColors } from './energyChartOption'
import styles from './EnergyChartView.module.css'

echarts.use([LineChart, GridComponent, LegendComponent, TooltipComponent, AriaComponent, SVGRenderer])

function readColors(el: HTMLElement): ChartColors {
  const css = getComputedStyle(el)
  const v = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback
  return {
    pv: v('--chart-pv', '#2e9e5b'),
    home: v('--chart-home', '#3b4a42'),
    grid: v('--chart-grid', '#2f80c7'),
    text: v('--color-text-muted', '#56635c'),
    border: v('--color-border', '#dfe6e2'),
  }
}

/** Cienki wrapper ECharts (D28): inicjalizacja, aktualizacja opcji, resize, sprzątanie. */
export function EnergyChartView({
  chart,
  timeZone,
  label,
}: {
  chart: EnergyChart
  timeZone: string
  label: string
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const instance = echarts.init(el, undefined, { renderer: 'svg' })
    instance.setOption(buildChartOption(chart, readColors(el), timeZone))
    const observer = new ResizeObserver(() => instance.resize())
    observer.observe(el)
    return () => {
      observer.disconnect()
      instance.dispose()
    }
  }, [chart, timeZone])

  return <div ref={ref} className={styles.chart} role="img" aria-label={label} />
}
