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

/**
 * Energia instalacji (D48): produkcja PV i zużycie w dwóch przedziałach — drugi przedział PV
 * z niepełnym pokryciem, zużycie bez pomiaru w drugim; bateria niedostępna (brak źródła).
 */
export function siteEnergy(from: string, to: string, origins = ['SIMULATED']) {
  const span = Date.parse(to) - Date.parse(from)
  const bucket = span <= 25 * 3_600_000 ? '1h' : span <= 32 * 86_400_000 ? '1d' : '1mo'
  const step = bucket === '1h' ? 3_600_000 : 86_400_000
  const t = (i: number) => new Date(Date.parse(from) + i * step).toISOString()
  const kpi = { value: null, status: 'UNAVAILABLE', reason: null, coverage: 0, definition: 'x' }
  return {
    timezone: 'Europe/Warsaw',
    bucket,
    origins,
    series: [
      {
        key: 'pv',
        metric: 'pv_energy_total',
        device_id: 'inv',
        source: 'COUNTER',
        total_wh: 12_400,
        coverage: 0.9,
        reset_detected: false,
        buckets: [
          { t: t(0), wh: 8_000, coverage: 1 },
          { t: t(1), wh: 4_400, coverage: 0.5 },
        ],
      },
      {
        key: 'load',
        metric: 'load_power',
        device_id: 'inv',
        source: 'POWER',
        total_wh: 5_250,
        coverage: 1,
        reset_detected: false,
        buckets: [
          { t: t(0), wh: 5_250, coverage: 1 },
          { t: t(1), wh: null, coverage: 0 },
        ],
      },
    ],
    kpis: { self_consumption: kpi, self_sufficiency: kpi },
    unavailable: [{ key: 'battery_charge', metric: 'battery_charge_energy_total', reason: 'NOT_PROVIDED', sources: 0 }],
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
    if (url.includes('/energy?')) {
      if (status !== 200) return json(status, { detail: 'x' })
      const params = new URL(url, 'https://x').searchParams
      return json(200, siteEnergy(params.get('from') ?? '', params.get('to') ?? ''))
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
