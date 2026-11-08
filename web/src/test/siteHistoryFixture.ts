/** Atrapy odpowiedzi API dla testów historii instalacji (D66). Dane SIMULATED tylko w testach. */
import { vi } from 'vitest'

export const SITE_ID = '0b5c3a52-6f0e-4d0b-9a77-6a1f2c3d4e5f'

export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

export function device(id: string, keys: string[], enabled = true) {
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
    metrics: keys.map((key) => ({
      key,
      channel: null,
      name: key,
      unit: key === 'battery_soc' ? '%' : 'W',
      cumulative: false,
    })),
  }
}

export function history(metric: string, values: Array<number | null>, origins = ['SIMULATED'], resolution = '5m') {
  return {
    metric,
    channel: null,
    unit: metric === 'battery_soc' ? '%' : 'W',
    cumulative: false,
    resolution,
    timezone: 'Europe/Warsaw',
    origins,
    points: values.map((value, i) => ({
      t: new Date(Date.parse('2026-11-06T23:00:00Z') + i * 300_000).toISOString(),
      value,
      min: value,
      max: value,
      coverage: value === null ? 0 : 1,
    })),
  }
}

/** Serwer z listą urządzeń i historią; `values` dla metryki albo domyślne [1000, null, 1200]. */
export function fakeServer(devices: unknown[], values: Record<string, Array<number | null>> = {}, status = 200) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input)
    if (url === `/api/sites/${SITE_ID}/devices`) return json(200, devices)
    if (url.includes('/history?')) {
      if (status !== 200) return json(status, { detail: 'x' })
      const metric = new URL(url, 'https://x').searchParams.get('metric') ?? ''
      return json(200, history(metric, values[metric] ?? [1000, null, 1200]))
    }
    return json(404, { detail: 'x' })
  })
}

export function historyUrls(fn: ReturnType<typeof fakeServer>): URL[] {
  return fn.mock.calls
    .map(([input]) => String(input))
    .filter((u) => u.includes('/history?'))
    .map((u) => new URL(u, 'https://x'))
}
