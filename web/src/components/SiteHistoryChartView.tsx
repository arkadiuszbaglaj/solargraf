import { useEffect, useRef } from 'react'
import { LineChart } from 'echarts/charts'
import { AriaComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import * as echarts from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'
import type { LoadedSeries } from '../lib/siteHistory'
import { buildSiteHistoryOption, type SiteChartColors } from './siteHistoryOption'
import styles from './EnergyChartView.module.css'

echarts.use([LineChart, GridComponent, LegendComponent, TooltipComponent, AriaComponent, SVGRenderer])

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
  }
}

/** Wrapper ECharts dla serii instalacji (D66): inicjalizacja, opcje, resize, sprzątanie. */
export function SiteHistoryChartView({
  series,
  timeZone,
  range,
  label,
}: {
  series: readonly LoadedSeries[]
  timeZone: string
  range: { from: Date; to: Date }
  label: string
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const instance = echarts.init(el, undefined, { renderer: 'svg' })
    instance.setOption(buildSiteHistoryOption(series, readColors(el), timeZone, range))
    const observer = new ResizeObserver(() => instance.resize())
    observer.observe(el)
    return () => {
      observer.disconnect()
      instance.dispose()
    }
  }, [series, timeZone, range])

  return <div ref={ref} className={styles.chart} role="img" aria-label={label} />
}
