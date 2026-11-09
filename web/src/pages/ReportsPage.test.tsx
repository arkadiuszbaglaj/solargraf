import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { getEnergyReport, parseReport, reportCsvUrl } from '../api/reports'
import { REPORTS_PATH, routeFor } from '../Root'
import { isCurrentOrLater, localYearMonth, periodLabel, shift } from './reportPeriod'
import { kwhCell, ReportsPage } from './ReportsPage'

// ECharts wymaga przeglądarki (wymiary, ResizeObserver); opcje wykresu testujemy osobno.
vi.mock('../components/EnergyBarsView', () => ({
  EnergyBarsView: ({ label }: { label: string }) => <div role="img" aria-label={label} />,
}))

const SITE = { id: '11111111-1111-1111-1111-111111111111', name: 'Dom', timezone: 'Europe/Warsaw' }
const NOW = new Date('2026-11-09T12:00:00Z')
const KPI = { value: 0.75, status: 'OK', reason: null, coverage: 1, definition: 'x' }

function series(key: string, values: Array<number | null>, total: number | null, source = 'COUNTER') {
  const days = ['2026-10-31T23:00:00Z', '2026-11-01T23:00:00Z']
  return {
    key,
    metric: `${key}_metric`,
    device_id: 'dev',
    source,
    total_wh: total,
    coverage: 1,
    reset_detected: false,
    buckets: days.map((t, i) => ({ t, wh: values[i] ?? null, coverage: i === 0 ? 1 : 0.5 })),
  }
}

function report(overrides: Record<string, unknown> = {}) {
  return {
    timezone: 'Europe/Warsaw',
    bucket: '1d',
    origins: ['SIMULATED'],
    series: [series('load', [2000, null], 2000, 'POWER'), series('pv', [5000, 1500], 6500)],
    kpis: { self_consumption: KPI, self_sufficiency: { ...KPI, value: null, status: 'UNAVAILABLE', reason: 'Brak.' } },
    unavailable: [{ key: 'grid_import', metric: 'm', reason: 'NOT_PROVIDED', sources: 0 }],
    period: 'month',
    year: 2026,
    month: 11,
    start: '2026-10-31T23:00:00Z',
    end: '2026-11-30T23:00:00Z',
    ...overrides,
  }
}

function fakeFetch(handler: (url: string) => Response) {
  return vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input) =>
    handler(String(input)),
  )
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('okres raportu', () => {
  it('bieżący miesiąc w strefie instalacji, krok przez granicę roku i etykiety', () => {
    expect(localYearMonth(new Date('2026-12-31T23:30:00Z'), 'Europe/Warsaw')).toEqual({ year: 2027, month: 1 })
    expect(shift({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 })
    expect(shift({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 })
    expect(shift({ year: 2026, month: null }, -1)).toEqual({ year: 2025, month: null })
    expect(isCurrentOrLater({ year: 2026, month: 11 }, NOW, 'Europe/Warsaw')).toBe(true)
    expect(isCurrentOrLater({ year: 2026, month: 10 }, NOW, 'Europe/Warsaw')).toBe(false)
    expect(isCurrentOrLater({ year: 2025, month: null }, NOW, 'Europe/Warsaw')).toBe(false)
    expect(periodLabel({ year: 2026, month: 11 })).toBe('listopad 2026')
    expect(periodLabel({ year: 2026, month: null })).toBe('rok 2026')
    expect(kwhCell(null)).toBe('—')
    expect(kwhCell(1550)).toBe('1,6')
  })
})

describe('API raportu', () => {
  it('waliduje odpowiedź i rozróżnia 403 oraz komunikat 422', async () => {
    expect(parseReport(report())?.month).toBe(11)
    expect(parseReport(report({ period: 'year' }))).toBeNull() // rok musi mieć month = null
    expect(parseReport(report({ month: 13 }))).toBeNull()
    expect(parseReport(report({ start: 'wczoraj' }))).toBeNull()
    expect(reportCsvUrl(SITE.id, { year: 2026, month: null })).toBe(`/api/sites/${SITE.id}/reports/energy.csv?year=2026`)

    const forbidden = await getEnergyReport(SITE.id, { year: 2026, month: 11 }, fakeFetch(() => json({}, 403)))
    expect(forbidden.kind).toBe('forbidden')
    const future = await getEnergyReport(
      SITE.id,
      { year: 2099, month: null },
      fakeFetch(() => json({ detail: 'Wybrany okres jeszcze się nie zaczął.' }, 422)),
    )
    expect(future).toEqual({ kind: 'error', message: 'Wybrany okres jeszcze się nie zaczął.' })
  })
})

describe('ReportsPage', () => {
  it('trasa /raporty', () => {
    expect(routeFor(REPORTS_PATH)).toBe('reports')
    expect(routeFor(`${REPORTS_PATH}/`)).toBe('reports')
  })

  it('bieżący miesiąc: sumy, wskaźniki, tabela z brakami jako „—”, CSV i oznaczenie SIMULATED', async () => {
    const fetchFn = fakeFetch(() => json(report()))
    render(<ReportsPage site={SITE} now={NOW} origin="DEVICE" fetchFn={fetchFn} />)
    const table = await screen.findByRole('table')
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe(`/api/sites/${SITE.id}/reports/energy?year=2026&month=11`)
    expect(screen.getByRole('heading', { level: 2, name: /Raport: listopad 2026/ })).toBeTruthy()
    expect(screen.getByText(/Raport zawiera dane symulowane/)).toBeTruthy()

    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent)
    expect(headers).toEqual(['Dzień', 'Produkcja PV [kWh]', 'Zużycie domu [kWh]'])
    const rows = within(table).getAllByRole('row').map((r) => Array.from(r.children, (c) => c.textContent))
    expect(rows[1]).toEqual(['niedz., 01.11', '5,0', '2,0'])
    expect(rows[2]).toEqual(['pon., 02.11', '1,5*', '—']) // brak danych — „—”, nie 0
    expect(rows[3]).toEqual(['Razem', '6,5', '2,0'])
    expect(screen.getByText('Zużycie domu wyliczone z mocy (brak licznika energii).')).toBeTruthy()
    expect(screen.getByText('Niedostępne w tej instalacji: pobór z sieci.')).toBeTruthy()

    const summary = screen.getByRole('region', { name: 'Podsumowanie okresu' })
    expect(within(summary).getByText('6,5 kWh')).toBeTruthy()
    expect(within(summary).getByText('75%')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Pobierz CSV' }).getAttribute('href')).toBe(
      `/api/sites/${SITE.id}/reports/energy.csv?year=2026&month=11`,
    )
    // Bieżący okres: następny niedostępny.
    expect((screen.getByRole('button', { name: 'Następny okres' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('nawigacja: poprzedni miesiąc i raport roczny', async () => {
    const fetchFn = fakeFetch(() => json(report()))
    render(<ReportsPage site={SITE} now={NOW} origin="DEVICE" fetchFn={fetchFn} />)
    await screen.findByRole('table')
    await userEvent.click(screen.getByRole('button', { name: 'Poprzedni okres' }))
    expect(String(fetchFn.mock.lastCall?.[0])).toMatch(/year=2026&month=10$/)
    await userEvent.click(screen.getByRole('button', { name: 'Rok' }))
    expect(String(fetchFn.mock.lastCall?.[0])).toMatch(/year=2026$/)
    expect(screen.getByRole('heading', { level: 2, name: /Raport: rok 2026/ })).toBeTruthy()
  })

  it('brak uprawnień, komunikat serwera i tryb DEMO', async () => {
    render(<ReportsPage site={SITE} now={NOW} origin="DEVICE" fetchFn={fakeFetch(() => json({}, 403))} />)
    expect(await screen.findByText('Raporty są dostępne dla właściciela i administratora instalacji.')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Pobierz CSV' })).toBeNull()

    const demoFetch = fakeFetch(() => json({}))
    render(<ReportsPage site={SITE} now={NOW} origin="DEMO" fetchFn={demoFetch} />)
    expect(screen.getByText('Raporty wymagają serwera — niedostępne w trybie DEMO.')).toBeTruthy()
    expect(demoFetch).not.toHaveBeenCalled()
  })
})
