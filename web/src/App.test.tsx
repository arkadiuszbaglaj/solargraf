import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { DataSourceProvider } from './data/DataSourceContext'
import { DemoDataSource } from './data/demo/DemoDataSource'
import type { DashboardDataSource } from './data/types'

// ECharts wymaga przeglądarki (wymiary, ResizeObserver); opcje wykresu testujemy osobno.
vi.mock('./components/EnergyChartView', () => ({
  EnergyChartView: ({ label }: { label: string }) => <div role="img" aria-label={label} />,
}))

const NOON = new Date('2026-11-07T11:00:00Z')

function renderApp(source: DashboardDataSource = new DemoDataSource({ now: () => NOON, latencyMs: 0 })) {
  return render(
    <DataSourceProvider source={source}>
      <App now={NOON} />
    </DataSourceProvider>,
  )
}

describe('Dashboard (DEMO)', () => {
  it('pokazuje widoczne oznaczenie DEMO i nagłówek strony', async () => {
    renderApp()
    expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeTruthy()
    expect(await screen.findByLabelText('Dane demonstracyjne')).toBeTruthy()
  })

  it('renderuje KPI, wykres, urządzenia i alarmy z danych demo', async () => {
    renderApp()
    expect(await screen.findByRole('heading', { name: 'Produkcja PV' })).toBeTruthy()
    expect(await screen.findByRole('img', { name: /Wykres mocy/ })).toBeTruthy()
    const devices = await screen.findByRole('region', { name: 'Status urządzeń' })
    await within(devices).findByText('Falownik')
    // Licznik nie odpowiada od 10 min — nie może być pokazany jako online.
    const meter = within(devices).getByText('Licznik sieci').closest('li')
    expect(meter?.textContent).toContain('Brak odpowiedzi')
    const alarms = screen.getByRole('region', { name: 'Ostatnie alarmy' })
    expect((await within(alarms).findByText(/Brak odpowiedzi urządzenia/)).textContent).toBeTruthy()
  })

  it('przełączenie na instalację z utraconym agentem: dane nieaktualne i stan nieznany', async () => {
    renderApp()
    const select = await screen.findByLabelText('Instalacja')
    await screen.findByRole('option', { name: /agent offline/ })
    await userEvent.selectOptions(select, 'demo-b')
    expect(await screen.findByText(/Dane nieaktualne — ostatni odczyt 25 min temu/)).toBeTruthy()
    const devices = screen.getByRole('region', { name: 'Status urządzeń' })
    await within(devices).findAllByText('Stan nieznany')
    expect(within(devices).queryByText('Online')).toBeNull()
  })

  it('błąd źródła danych pokazuje komunikat i przycisk ponowienia', async () => {
    const failing: DashboardDataSource = {
      origin: 'DEMO',
      listSites: () => Promise.reject(new Error('szczegóły, których nie pokazujemy')),
      getKpis: () => Promise.reject(new Error('x')),
      getEnergyChart: () => Promise.reject(new Error('x')),
      getDevices: () => Promise.reject(new Error('x')),
      getAlarms: () => Promise.reject(new Error('x')),
    }
    renderApp(failing)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).not.toContain('szczegóły')
    expect(within(alert).getByRole('button', { name: 'Spróbuj ponownie' })).toBeTruthy()
  })

  it('klawiatura: pierwszy Tab to link „Przejdź do treści”, potem przełącznik instalacji', async () => {
    renderApp()
    await screen.findByRole('option', { name: /demonstracyjna A/ })
    await userEvent.tab()
    expect(document.activeElement?.textContent).toBe('Przejdź do treści')
    await userEvent.tab()
    expect(document.activeElement?.getAttribute('href')).toBe('/')
    expect(document.activeElement?.getAttribute('aria-current')).toBe('page')
    await userEvent.tab()
    expect(document.activeElement?.getAttribute('href')).toBe('/instalacje')
    expect(document.activeElement?.getAttribute('aria-current')).toBeNull()
    await userEvent.tab()
    expect(document.activeElement?.getAttribute('href')).toBe('/wykresy')
    await userEvent.tab()
    expect(document.activeElement?.getAttribute('href')).toBe('/urzadzenia')
    await userEvent.tab()
    // Przycisk menu (widoczny na małych ekranach) i select instalacji są osiągalne z klawiatury.
    expect(document.activeElement?.getAttribute('aria-controls')).toBeTruthy()
    await userEvent.tab()
    expect(document.activeElement?.tagName).toBe('SELECT')
  })

  it('nieaktywne pozycje menu są oznaczone i nie są linkami', () => {
    renderApp()
    const nav = screen.getByRole('navigation', { name: 'Główna nawigacja' })
    expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual([
      'Dashboard',
      'Instalacje',
      'Wykresy i historia',
      'Urządzenia',
    ])
    expect(within(nav).getByText('Alarmy').closest('[aria-disabled="true"]')).toBeTruthy()
  })

  it('strona wykresów w DEMO: aktywna pozycja menu i komunikat zamiast danych', async () => {
    render(
      <DataSourceProvider source={new DemoDataSource({ now: () => NOON, latencyMs: 0 })}>
        <App now={NOON} page="charts" />
      </DataSourceProvider>,
    )
    expect(await screen.findByText('Historia pomiarów wymaga serwera — niedostępna w trybie DEMO.')).toBeTruthy()
    const nav = screen.getByRole('navigation', { name: 'Główna nawigacja' })
    expect(within(nav).getByRole('link', { name: 'Wykresy i historia' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('heading', { level: 1, name: 'Wykresy i historia' })).toBeTruthy()
  })
})

describe('zakładka Urządzenia', () => {
  it('w DEMO: aktywna pozycja menu, przełącznik instalacji i komunikat zamiast danych', async () => {
    render(
      <DataSourceProvider source={new DemoDataSource({ now: () => NOON, latencyMs: 0 })}>
        <App now={NOON} page="devices" />
      </DataSourceProvider>,
    )
    expect(await screen.findByText('Lista urządzeń wymaga serwera — niedostępna w trybie DEMO.')).toBeTruthy()
    const nav = screen.getByRole('navigation', { name: 'Główna nawigacja' })
    expect(within(nav).getByRole('link', { name: 'Urządzenia' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('heading', { level: 1, name: 'Urządzenia' })).toBeTruthy()
    expect(screen.getByRole('combobox')).toBeTruthy()
  })
})

describe('przycisk menu', () => {
  it('przełącza aria-expanded', async () => {
    renderApp()
    const button = screen.getByRole('button', { name: 'Menu' })
    expect(button.getAttribute('aria-expanded')).toBe('false')
    await userEvent.click(button)
    await waitFor(() => expect(button.getAttribute('aria-expanded')).toBe('true'))
  })
})
