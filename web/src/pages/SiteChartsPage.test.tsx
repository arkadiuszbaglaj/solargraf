import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CHARTS_PATH, routeFor } from '../Root'
import { device, fakeServer, historyUrls, json, SITE_ID } from '../test/siteHistoryFixture'
import { SiteChartsPage } from './SiteChartsPage'

// ECharts wymaga przeglądarki (wymiary, ResizeObserver); opcje wykresu testujemy osobno.
vi.mock('../components/SiteHistoryChartView', () => ({
  SiteHistoryChartView: ({ label, zoom }: { label: string; zoom: { start: number; end: number } }) => (
    <div role="img" aria-label={label} data-zoom={`${zoom.start}-${zoom.end}`} />
  ),
}))

const SITE = { id: SITE_ID, name: 'Dom', timezone: 'Europe/Warsaw' }
const NOW = new Date('2026-11-07T12:00:00Z')
const HYBRID = device('inv', ['pv_power', 'load_power', 'grid_power', 'battery_power', 'battery_soc'])

describe('trasa wykresów', () => {
  it('rozpoznaje /wykresy', () => {
    expect(routeFor(CHARTS_PATH)).toBe('charts')
    expect(routeFor(`${CHARTS_PATH}/`)).toBe('charts')
  })
})

const zooms = () => screen.getAllByRole('img').map((i) => i.getAttribute('data-zoom'))
const button = (name: string) => screen.getByRole('button', { name })

describe('SiteChartsPage (D66)', () => {
  it('pokazuje moc i SoC dnia w strefie instalacji z oznaczeniem SIMULATED', async () => {
    const fetchFn = fakeServer([HYBRID])
    render(<SiteChartsPage site={SITE} now={NOW} origin="DEVICE" fetchFn={fetchFn} />)
    expect(await screen.findByRole('img', { name: /^Wykres mocy w kW: Produkcja PV, Zużycie domu/ })).toBeTruthy()
    expect(screen.getByRole('img', { name: /stanu naładowania baterii/ })).toBeTruthy()
    expect(screen.getAllByText('SIMULATED')).toHaveLength(2)
    expect(screen.getByText(/rozdzielczość: 5 min/)).toBeTruthy()
    expect(screen.getByText('7 listopada 2026')).toBeTruthy()
    const url = historyUrls(fetchFn)[0]
    expect(url?.searchParams.get('from')).toBe('2026-11-06T23:00:00.000Z')
    expect(url?.searchParams.get('to')).toBe('2026-11-07T23:00:00.000Z')
  })

  it('okres i nawigacja działają z klawiatury', async () => {
    const user = userEvent.setup()
    const fetchFn = fakeServer([HYBRID])
    render(<SiteChartsPage site={SITE} now={NOW} origin="DEVICE" fetchFn={fetchFn} />)
    await screen.findAllByRole('img')
    expect(screen.getByRole('button', { name: 'Następny okres' }).hasAttribute('disabled')).toBe(true)

    screen.getByRole('button', { name: 'Tydzień' }).focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: 'Tydzień' }).getAttribute('aria-pressed')).toBe('true')
    screen.getByRole('button', { name: 'Poprzedni okres' }).focus()
    await user.keyboard(' ')
    expect(await screen.findByText('26.10.2026 – 01.11.2026')).toBeTruthy()
    expect(historyUrls(fetchFn).at(-1)?.searchParams.get('from')).toBe('2026-10-25T23:00:00.000Z')
    expect(screen.getByRole('button', { name: 'Dziś' }).hasAttribute('disabled')).toBe(false)
  })

  it('przybliżenie z przycisków: oba wykresy, widoczny fragment, reset przy zmianie okresu', async () => {
    const user = userEvent.setup()
    render(<SiteChartsPage site={SITE} now={NOW} origin="DEVICE" fetchFn={fakeServer([HYBRID])} />)
    await screen.findAllByRole('img')
    expect(screen.getByRole('group', { name: 'Przybliżenie wykresów' })).toBeTruthy()
    expect(screen.getByText(/Zaznacz fragment wykresu myszą/)).toBeTruthy()
    for (const name of ['Oddal', '← Wcześniej', 'Później →', 'Cały okres']) {
      expect(button(name).hasAttribute('disabled')).toBe(true)
    }

    await user.click(button('Przybliż'))
    expect(zooms()).toEqual(['25-75', '25-75'])
    expect(screen.getByText('Widoczne: 7.11.2026, 06:00 – 7.11.2026, 18:00')).toBeTruthy()
    expect(screen.getByRole('img', { name: /Wykres mocy/ })).toBeTruthy()

    await user.click(button('← Wcześniej'))
    expect(zooms()).toEqual(['0-50', '0-50'])
    expect(button('← Wcześniej').hasAttribute('disabled')).toBe(true)
    await user.click(button('Oddal'))
    expect(zooms()).toEqual(['0-100', '0-100'])

    await user.click(button('Przybliż'))
    await user.click(button('Poprzedni okres'))
    expect(await screen.findByText('6 listopada 2026')).toBeTruthy()
    await screen.findAllByRole('img')
    expect(zooms()).toEqual(['0-100', '0-100'])
  })

  it('zakres własny: start od oglądanego okresu, walidacja i zastosowanie', async () => {
    const user = userEvent.setup()
    const fetchFn = fakeServer([HYBRID])
    render(<SiteChartsPage site={SITE} now={NOW} origin="DEVICE" fetchFn={fetchFn} />)
    await screen.findAllByRole('img')
    await user.click(screen.getByRole('button', { name: 'Własny' }))
    expect(screen.queryByRole('button', { name: 'Poprzedni okres' })).toBeNull()
    const from = screen.getByLabelText<HTMLInputElement>('Od')
    const to = screen.getByLabelText<HTMLInputElement>('Do')
    expect([from.value, to.value]).toEqual(['2026-11-07', '2026-11-07'])

    await user.clear(from)
    await user.type(from, '2026-11-09')
    await user.click(screen.getByRole('button', { name: 'Pokaż' }))
    expect(screen.getByRole('alert').textContent).toBe('Data „od” musi być wcześniejsza niż „do” albo taka sama.')
    expect(from.getAttribute('aria-invalid')).toBe('true')

    await user.clear(from)
    await user.type(from, '2026-10-24')
    await user.clear(to)
    await user.type(to, '2026-10-26')
    await user.click(screen.getByRole('button', { name: 'Pokaż' }))
    expect(await screen.findByText('24.10.2026 – 26.10.2026')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    const last = historyUrls(fetchFn).at(-1)
    expect(last?.searchParams.get('from')).toBe('2026-10-23T22:00:00.000Z')
    expect(last?.searchParams.get('to')).toBe('2026-10-26T23:00:00.000Z')
  })

  it('brak danych to stan pusty, nie wykres zer; brak baterii opisany', async () => {
    const fetchFn = fakeServer([device('inv', ['pv_power'])], { pv_power: [null, null] })
    render(<SiteChartsPage site={SITE} now={NOW} origin="DEVICE" fetchFn={fetchFn} />)
    expect(await screen.findByText('Brak danych w tym okresie.')).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText(/Niedostępne: .*Stan naładowania baterii — brak źródła/)).toBeTruthy()
  })

  it('instalacja bez serii mocy', async () => {
    render(<SiteChartsPage site={SITE} now={NOW} origin="DEVICE" fetchFn={fakeServer([])} />)
    expect(await screen.findByText('Urządzenia instalacji nie podają mocy PV, zużycia, sieci ani baterii.')).toBeTruthy()
  })

  it('błąd pozwala ponowić; wygasła sesja przekierowuje do logowania', async () => {
    render(
      <SiteChartsPage site={SITE} now={NOW} origin="DEVICE" fetchFn={fakeServer([HYBRID], {}, 500)} />,
    )
    expect(await screen.findByRole('button', { name: 'Spróbuj ponownie' })).toBeTruthy()

    const navigate = vi.fn<(url: string) => void>()
    const anon = vi.fn<typeof fetch>(async () => json(401, {}))
    render(<SiteChartsPage site={SITE} now={NOW} origin="DEVICE" fetchFn={anon} navigate={navigate} />)
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.stringContaining('reason=expired')))
  })

  it('w trybie DEMO nie pyta serwera i mówi, że historia jest niedostępna', () => {
    const fetchFn = vi.fn<typeof fetch>()
    render(<SiteChartsPage site={SITE} now={NOW} origin="DEMO" fetchFn={fetchFn} />)
    expect(screen.getByText('Historia pomiarów wymaga serwera — niedostępna w trybie DEMO.')).toBeTruthy()
    expect(screen.getByText('DEMO')).toBeTruthy()
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
