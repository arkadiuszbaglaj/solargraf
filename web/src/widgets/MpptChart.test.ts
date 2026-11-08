import { describe, expect, it, vi } from 'vitest'
import type { History } from '../api/history'
import type { LiveDevice } from '../api/live'
import { buildStringOption } from '../components/stringChartOption'
import { loadMpptChart } from './MpptChart'

const NOW = new Date('2026-11-07T12:00:00Z')
const TZ = 'Europe/Warsaw'

function device(id: string, metrics: Array<[string, number]>, enabled = true): LiveDevice {
  return {
    id,
    name: id,
    kind: 'INVERTER',
    enabled,
    freshnessThresholdSeconds: 60,
    metrics: metrics.map(([key, channel]) => ({ key, channel, name: key, unit: '', cumulative: false })),
  }
}

function history(metric: string, values: Array<number | null>): History {
  return {
    metric,
    channel: 2,
    unit: metric === 'pv_string_voltage' ? 'V' : 'A',
    cumulative: false,
    resolution: '5m',
    timezone: TZ,
    origins: ['SIMULATED'],
    points: values.map((value, i) => ({
      t: new Date(Date.parse('2026-11-07T08:00:00Z') + i * 300_000).toISOString(),
      value,
      min: value,
      max: value,
      coverage: value === null ? 0 : 1,
    })),
  }
}

describe('loadMpptChart', () => {
  it('pobiera napięcie i prąd wybranego kanału od północy w strefie instalacji', async () => {
    const urls: string[] = []
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input), 'http://x')
      urls.push(`${url.pathname}?${url.searchParams.get('metric')}&${url.searchParams.get('channel')}`)
      expect(url.searchParams.get('from')).toBe('2026-11-06T23:00:00.000Z')
      expect(url.searchParams.get('resolution')).toBe('5m')
      return new Response(JSON.stringify(history(url.searchParams.get('metric') ?? '', [400, null])))
    })
    const inv = device('inv', [
      ['pv_string_voltage', 2],
      ['pv_string_current', 2],
    ])
    const data = await loadMpptChart('s1', [inv], 2, TZ, NOW, fetchFn)
    expect(urls.toSorted()).toEqual([
      '/api/sites/s1/devices/inv/history?pv_string_current&2',
      '/api/sites/s1/devices/inv/history?pv_string_voltage&2',
    ])
    expect(data.voltage?.points.map((p) => p.value)).toEqual([400, null])
    expect(data.range).toEqual({ from: new Date('2026-11-06T23:00:00Z'), to: NOW })
  })

  it('seria bez jednego źródła jest pomijana, bez zapytania (D50)', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(history('pv_string_voltage', [1]))))
    const a = device('a', [
      ['pv_string_voltage', 1],
      ['pv_string_current', 1],
    ])
    const b = device('b', [['pv_string_current', 1]])
    const data = await loadMpptChart('s1', [a, b], 1, TZ, NOW, fetchFn)
    expect(fetchFn).toHaveBeenCalledOnce()
    expect(data.current).toBeNull()
  })

  it('błąd API to błąd widżetu, nie pusty wykres', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response('{}', { status: 500 }))
    const inv = device('inv', [['pv_string_voltage', 1]])
    await expect(loadMpptChart('s1', [inv], 1, TZ, NOW, fetchFn)).rejects.toThrow('historii stringu')
  })
})

describe('buildStringOption', () => {
  const colors = { voltage: '#0a0', current: '#00a', text: '#333', border: '#ccc' }
  const range = { from: new Date('2026-11-06T23:00:00Z'), to: NOW }

  it('dwie osie (V, A), luki jako null bez łączenia linii', () => {
    const option = buildStringOption(
      history('pv_string_voltage', [400, null, 410]),
      history('pv_string_current', [6.5, null, 6.8]),
      colors,
      TZ,
      range,
    )
    expect((option.yAxis as Array<{ name: string }>).map((a) => a.name)).toEqual(['V', 'A'])
    const series = option.series as Array<{ name: string; yAxisIndex: number; connectNulls: boolean; data: unknown[] }>
    expect(series.map((s) => [s.name, s.yAxisIndex, s.connectNulls])).toEqual([
      ['Napięcie', 0, false],
      ['Prąd', 1, false],
    ])
    expect(series[0]!.data[1]).toEqual([Date.parse('2026-11-07T08:05:00Z'), null])
  })

  it('podpowiedź: brak danych zamiast 0, tekst escapowany', () => {
    const option = buildStringOption(history('pv_string_voltage', [400, null]), null, colors, TZ, range)
    const formatter = (option.tooltip as { formatter: (p: unknown) => string }).formatter
    expect(formatter([{ dataIndex: 1 }])).toBe('09:05<br>Napięcie: brak danych')
    expect(formatter([{ dataIndex: 0 }])).toBe('09:00<br>Napięcie: 400,0 V')
    expect((option.series as unknown[]).length).toBe(1)
  })
})
