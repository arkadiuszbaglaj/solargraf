import { useEffect, useRef } from 'react'
import { LineChart } from 'echarts/charts'
import { AriaComponent, GridComponent, TooltipComponent } from 'echarts/components'
import * as echarts from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'
import type { History } from '../api/history'
import { buildHistoryOption, type HistoryColors } from './historyChartOption'
import styles from './EnergyChartView.module.css'

echarts.use([LineChart, GridComponent, TooltipComponent, AriaComponent, SVGRenderer])

function readColors(el: HTMLElement): HistoryColors {
  const css = getComputedStyle(el)
  const v = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback
  return {
    line: v('--chart-pv', '#2e9e5b'),
    text: v('--color-text-muted', '#56635c'),
    border: v('--color-border', '#dfe6e2'),
  }
}

/** Wrapper ECharts dla historii metryki (D47): inicjalizacja, opcje, resize, sprzątanie. */
export function HistoryChartView({
  history,
  timeZone,
  range,
  label,
}: {
  history: History
  timeZone: string
  range: { from: Date; to: Date }
  label: string
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const instance = echarts.init(el, undefined, { renderer: 'svg' })
    instance.setOption(buildHistoryOption(history, readColors(el), timeZone, range))
    const observer = new ResizeObserver(() => instance.resize())
    observer.observe(el)
    return () => {
      observer.disconnect()
      instance.dispose()
    }
  }, [history, timeZone, range])

  return <div ref={ref} className={styles.chart} role="img" aria-label={label} />
}
