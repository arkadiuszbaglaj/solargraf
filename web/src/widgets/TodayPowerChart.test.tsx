import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { loadTodayChart, TodayPowerChart } from './TodayPowerChart'

vi.mock('../components/EnergyChartView', () => ({
  EnergyChartView: ({ label }: { label: string }) => <div role="img" aria-label={label} />,
}))

const SITE = '11111111-1111-1111-1111-111111111111'
const NOW = new Date('2026-11-07T11:00:00Z') // 12:00 w Warszawie

const metric = (key: string) => ({ key, channel: null, name: key, unit: 'W', cumulative: false })

function device(id: string, keys: string[], enabled = true) {
  return {
    id,
    parent_device_id: null,
    name: id,
    kind: 'INVERTER',
    manufacturer: null,
    model: null,
    enabled,
    status: 'OK',
    last_success_at: null,
    details: null,
    metrics: keys.map(metric),
  }
}

function history(metricKey: string, values: Array<number | null>) {
  return {
    metric: metricKey,
    channel: null,
    unit: 'W',
    cumulative: false,
    resolution: '5m',
    timezone: 'Europe/Warsaw',
    origins: ['SIMULATED'],
    points: values.map((value, i) => ({
      t: new Date(Date.parse('2026-11-06T23:00:00Z') + i * 300_000).toISOString(),
      value,
      min: value,
      max: value,
      coverage: value === null ? 0 : 1,
    })),
  }
}

function fakeFetch(devices: unknown[]) {
  const urls: string[] = []
  const fn = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async (input) => {
    const url = String(input)
    urls.push(url)
    if (url.endsWith('/devices')) return new Response(JSON.stringify(devices))
    const m = new URL(url, 'https://x').searchParams.get('metric') ?? ''
    return new Response(JSON.stringify(history(m, [1000, null, 1200])))
  })
  return { fn: fn as unknown as typeof fetch, urls }
}

describe('loadTodayChart', () => {
  it('pobiera 5 min od północy lokalnej z jednego źródła na linię, luki zostają null', async () => {
    const { fn, urls } = fakeFetch([
      device('inv', ['pv_power', 'load_power', 'grid_power']),
      device('meter', ['grid_power']),
    ])
    const today = await loadTodayChart(SITE, 'Europe/Warsaw', NOW, fn)
    const historyUrls = urls.filter((u) => u.includes('/history'))
    expect(historyUrls).toHaveLength(2) // sieć ma dwa źródła — bez zapytania
    const params = new URL(historyUrls[0] ?? '', 'https://x').searchParams
    expect(params.get('resolution')).toBe('5m')
    expect(params.get('from')).toBe('2026-11-06T23:00:00.000Z')
    expect(today.missing).toEqual(['sieć — wiele źródeł'])
    expect(today.chart.pv.map(([, v]) => v)).toEqual([1000, null, 1200])
    expect(today.chart.gridImport).toEqual([])
    expect(today.simulated).toBe(true)
  })

  it('wyłączone urządzenie nie jest źródłem', async () => {
    const { fn } = fakeFetch([device('inv', ['pv_power']), device('old', ['pv_power'], false)])
    const today = await loadTodayChart(SITE, 'Europe/Warsaw', NOW, fn)
    expect(today.missing).toEqual(['zużycie domu — brak źródła', 'sieć — brak źródła'])
    // Instalacja bez magazynu to nie brak danych.
    expect(today.chart.battery).toBeUndefined()
  })

  it('magazyn energii z jednego źródła jako linia; kilka źródeł — opis', async () => {
    const one = fakeFetch([device('inv', ['pv_power', 'load_power', 'grid_power', 'battery_power'])])
    const today = await loadTodayChart(SITE, 'Europe/Warsaw', NOW, one.fn)
    expect(today.chart.battery?.map(([, v]) => v)).toEqual([1000, null, 1200])
    expect(today.missing).toEqual([])
    const many = fakeFetch([device('inv', ['pv_power', 'battery_power']), device('bms', ['battery_power'])])
    const split = await loadTodayChart(SITE, 'Europe/Warsaw', NOW, many.fn)
    expect(split.chart.battery).toBeUndefined()
    expect(split.missing).toContain('magazyn energii — wiele źródeł')
  })
})

describe('TodayPowerChart', () => {
  it('pokazuje wykres z oznaczeniem SIMULATED i opisem niedostępnych linii', async () => {
    const { fn } = fakeFetch([device('inv', ['pv_power', 'load_power'])])
    render(<TodayPowerChart siteId={SITE} timeZone="Europe/Warsaw" fetchFn={fn} />)
    expect(await screen.findByRole('img', { name: /Wykres mocy od północy/ })).toBeTruthy()
    expect(screen.getByLabelText('Dane symulowane')).toBeTruthy()
    expect(screen.getByText(/Niedostępne: sieć — brak źródła/)).toBeTruthy()
  })

  it('bez żadnego źródła mocy — komunikat zamiast pustego wykresu', async () => {
    const { fn } = fakeFetch([device('bms', ['battery_soc'])])
    render(<TodayPowerChart siteId={SITE} timeZone="Europe/Warsaw" fetchFn={fn} />)
    expect(await screen.findByText(/nie podają mocy PV, zużycia, sieci ani magazynu energii/)).toBeTruthy()
  })
})
