import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { parseDevice, type ApiDevice } from '../api/devices'
import { SiteDevicesPanel, summary } from './SiteDevicesPanel'

const SITE = '11111111-1111-1111-1111-111111111111'
const NOW = new Date('2026-11-07T12:00:00Z')
const AGENT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

function device(
  name: string,
  status: string,
  agentId: string | null = AGENT,
  secondsAgo: number | null = 30,
  supportLevel: string | null = 'COMMUNITY',
) {
  return {
    id: `id-${name}`,
    parent_device_id: null,
    name,
    kind: 'INVERTER',
    manufacturer: null,
    model: null,
    enabled: status !== 'DISABLED',
    status,
    last_success_at: secondsAgo === null ? null : new Date(NOW.getTime() - secondsAgo * 1000).toISOString(),
    agent_id: agentId,
    details: null,
    metrics: [],
    support_level: supportLevel,
  }
}

function agent(status: string, secondsAgo = 12) {
  return {
    id: AGENT,
    name: 'lokalny',
    status,
    last_heartbeat_at: new Date(NOW.getTime() - secondsAgo * 1000).toISOString(),
    version: null,
  }
}

function fakeFetch(devices: unknown[], agents: unknown[]): typeof fetch {
  return vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async (input) =>
    new Response(JSON.stringify(String(input).endsWith('/agents') ? agents : devices)),
  ) as unknown as typeof fetch
}

const parsed = (raw: unknown): ApiDevice => {
  const d = parseDevice(raw)
  if (!d) throw new Error('fixture')
  return d
}

describe('summary', () => {
  it('liczy działające z włączonych i problemy (ERROR, STALE, UNKNOWN)', () => {
    const devices = ['OK', 'ERROR', 'STALE', 'UNKNOWN', 'DISABLED'].map((s, i) => parsed(device(`d${i}`, s)))
    expect(summary(devices)).toEqual({ text: '1 z 4 działa', problems: 3 })
  })
})

describe('SiteDevicesPanel', () => {
  it('pokazuje status z serwera, wiek odczytu, agenta i podsumowanie', async () => {
    const fetchFn = fakeFetch([device('Falownik', 'OK'), device('Licznik', 'ERROR', AGENT, null)], [agent('ONLINE')])
    render(<SiteDevicesPanel siteId={SITE} now={NOW} fetchFn={fetchFn} />)
    expect(await screen.findByText(/1 z 2 działa/)).toBeTruthy()
    expect(screen.getByText(/wymaga uwagi: 1/)).toBeTruthy()
    const agents = screen.getByRole('list', { name: 'Agenci' })
    expect(within(agents).getByText(/Agent lokalny — połączony, heartbeat 12 s temu/)).toBeTruthy()
    const meter = screen.getByText('Licznik').closest('li')?.textContent ?? ''
    expect(meter).toContain('Błąd odczytu')
    expect(meter).toContain('ostatni odczyt nigdy')
    expect(screen.getByText('Falownik').closest('li')?.textContent).toContain('Działa')
    expect(screen.getAllByText('Z dokumentacji, test na symulatorze')).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'Lista urządzeń' }).getAttribute('href')).toBe(`/instalacje/${SITE}/urzadzenia`)
  })

  it('nieosiągalny agent: ostrzeżenie i stan nieznany, nigdy „offline”', async () => {
    const fetchFn = fakeFetch([device('Falownik', 'UNKNOWN')], [agent('UNREACHABLE', 3600)])
    render(<SiteDevicesPanel siteId={SITE} now={NOW} fetchFn={fetchFn} />)
    expect(await screen.findByText(/Agent nie odpowiada/)).toBeTruthy()
    expect(screen.getByText(/nieosiągalny, heartbeat 1 h temu/)).toBeTruthy()
    expect(screen.getByText('Stan nieznany')).toBeTruthy()
    expect(document.body.textContent?.toLowerCase()).not.toContain('offline')
  })

  it('połączenie bez agenta i brak urządzeń', async () => {
    const { unmount } = render(
      <SiteDevicesPanel siteId={SITE} now={NOW} fetchFn={fakeFetch([device('Falownik', 'UNKNOWN', null)], [])} />,
    )
    expect(await screen.findByText(/brak agenta/)).toBeTruthy()
    unmount()
    render(<SiteDevicesPanel siteId={SITE} now={NOW} fetchFn={fakeFetch([], [])} />)
    expect(await screen.findByText('Brak skonfigurowanych urządzeń.')).toBeTruthy()
  })
})
