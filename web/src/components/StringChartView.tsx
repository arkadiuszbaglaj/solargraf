import { useEffect, useRef } from 'react'
import { LineChart } from 'echarts/charts'
import { AriaComponent, GridComponent, TooltipComponent } from 'echarts/components'
import * as echarts from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'
import type { History } from '../api/history'
import { buildStringOption, type StringChartColors } from './stringChartOption'
import styles from './StringChartView.module.css'

echarts.use([LineChart, GridComponent, TooltipComponent, AriaComponent, SVGRenderer])

function readColors(el: HTMLElement): StringChartColors {
  const css = getComputedStyle(el)
  const v = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback
  return {
    voltage: v('--chart-pv', '#2e9e5b'),
    current: v('--chart-grid', '#2f80c7'),
    text: v('--color-text-muted', '#56635c'),
    border: v('--color-border', '#dfe6e2'),
  }
}

/** Wrapper ECharts wykresu napięcia i prądu stringu (D69). */
export function StringChartView({
  voltage,
  current,
  timeZone,
  range,
  label,
}: {
  voltage: History | null
  current: History | null
  timeZone: string
  range: { from: Date; to: Date }
  label: string
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const instance = echarts.init(el, undefined, { renderer: 'svg' })
    instance.setOption(buildStringOption(voltage, current, readColors(el), timeZone, range))
    const observer = new ResizeObserver(() => instance.resize())
    observer.observe(el)
    return () => {
      observer.disconnect()
      instance.dispose()
    }
  }, [voltage, current, timeZone, range])

  return <div ref={ref} className={styles.chart} role="img" aria-label={label} />
}
