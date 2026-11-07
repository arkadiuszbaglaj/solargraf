import { useEffect, useRef } from 'react'
import { BarChart } from 'echarts/charts'
import { AriaComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import * as echarts from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'
import type { Energy } from '../api/energy'
import { buildEnergyOption, type EnergyColors } from './energyBarsOption'
import styles from './EnergyChartView.module.css'

echarts.use([BarChart, GridComponent, LegendComponent, TooltipComponent, AriaComponent, SVGRenderer])

function readColors(el: HTMLElement): EnergyColors {
  const css = getComputedStyle(el)
  const v = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback
  return {
    pv: v('--chart-pv', '#2e9e5b'),
    home: v('--chart-home', '#3b4a42'),
    grid: v('--chart-grid', '#2f80c7'),
    export: v('--chart-export', '#b8681f'),
    battery: v('--chart-battery', '#7556c2'),
    text: v('--color-text-muted', '#56635c'),
    border: v('--color-border', '#dfe6e2'),
  }
}

/** Słupki energii w przedziałach (D48): inicjalizacja, opcje, resize, sprzątanie. */
export function EnergyBarsView({ energy, timeZone, label }: { energy: Energy; timeZone: string; label: string }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const instance = echarts.init(el, undefined, { renderer: 'svg' })
    instance.setOption(buildEnergyOption(energy, readColors(el), timeZone))
    const observer = new ResizeObserver(() => instance.resize())
    observer.observe(el)
    return () => {
      observer.disconnect()
      instance.dispose()
    }
  }, [energy, timeZone])

  return <div ref={ref} className={styles.chart} role="img" aria-label={label} />
}
