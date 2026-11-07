/** Odpowiedź `GET …/energy` do testów (D48). */
export const KPI = { value: 0.944, status: 'OK', reason: null, coverage: 1, definition: 'Autokonsumpcja = …' }
export const ENERGY_BODY = {
  timezone: 'Europe/Warsaw',
  bucket: '1h',
  origins: ['SIMULATED'],
  series: [
    {
      key: 'pv',
      metric: 'pv_energy_total',
      source: 'COUNTER',
      total_wh: 800,
      coverage: 0.5,
      reset_detected: true,
      buckets: [
        { t: '2026-11-06T23:00:00Z', wh: 500, coverage: 1 },
        { t: '2026-11-07T00:00:00Z', wh: null, coverage: 0 },
        { t: '2026-11-07T01:00:00Z', wh: 0, coverage: 1 },
      ],
    },
  ],
  kpis: { self_consumption: KPI, self_sufficiency: { ...KPI, value: null, status: 'UNAVAILABLE', reason: 'Brak.' } },
}
