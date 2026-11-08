import { act, render, renderHook, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TestTarget } from '../api/devices'
import { parseConnectionTest, validateTarget } from '../api/devices'
import type { TestRun } from './ConnectionTestResult'
import { ConnectionTestResult, TEST_GIVE_UP_MS, useConnectionTest } from './ConnectionTestResult'

const SITE_ID = 'site-1'
const TARGET: TestTarget = {
  host: '192.168.1.60',
  port: 502,
  unitId: 3,
  profileId: 'simulated.hybrid-inverter',
  profileVersion: '0.1.0',
}
const READINGS = [
  { metric: 'pv_power', channel: null, name: 'Moc PV', unit: 'W', value: 1500, quality: 'GOOD' },
  { metric: 'pv_string_voltage', channel: 1, name: 'Napięcie stringu PV', unit: 'V', value: null, quality: 'MISSING' },
]
const test = (state: string, extra: object = {}) => ({
  id: 't1',
  state,
  created_at: '2026-11-08T12:00:00Z',
  finished_at: null,
  result: null,
  error_code: null,
  origin: null,
  readings: [],
  ...extra,
})
const DONE = test('DONE', { result: 'PARTIAL', error_code: 'MODBUS_EXCEPTION', origin: 'SIMULATED', readings: READINGS })
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

describe('api: test połączenia', () => {
  it('parsuje wynik; brak odczytu to null, nie zero', () => {
    const parsed = parseConnectionTest(DONE)
    expect(parsed?.result).toBe('PARTIAL')
    expect(parsed?.errorCode).toBe('MODBUS_EXCEPTION')
    expect(parsed?.readings[1]).toEqual({
      metric: 'pv_string_voltage',
      channel: 1,
      name: 'Napięcie stringu PV',
      unit: 'V',
      value: null,
      quality: 'MISSING',
    })
    expect(parseConnectionTest(test('PENDING'))?.readings).toEqual([])
  })

  it('odrzuca nieznany stan, kod błędu i wartość innego typu', () => {
    expect(parseConnectionTest(test('OFFLINE'))).toBeNull()
    expect(parseConnectionTest(test('DONE', { result: 'FAILED', error_code: 'X' }))).toBeNull()
    const bad = [{ ...READINGS[0], value: '1500' }]
    expect(parseConnectionTest(test('DONE', { result: 'OK', readings: bad }))).toBeNull()
  })

  it('walidacja celu testu: adres, port, Unit ID i profil', () => {
    const profiles = [
      {
        id: 'simulated.hybrid-inverter',
        version: '0.1.0',
        name: 'F',
        manufacturer: 'S',
        deviceKind: 'INVERTER',
        simulated: true,
        supportLevel: null,
        modbusTcp: true,
        pollIntervalSeconds: 10,
      },
    ]
    const form = { host: ' 192.168.1.60 ', port: '502', unitId: '3', profile: 'simulated.hybrid-inverter@0.1.0' }
    expect(validateTarget(form, profiles)).toEqual({ errors: {}, target: TARGET })
    const bad = validateTarget({ host: '8.8.8.8', port: '0', unitId: '256', profile: '' }, profiles)
    expect(bad.target).toBeNull()
    expect(Object.keys(bad.errors).toSorted()).toEqual(['host', 'port', 'profile', 'unitId'])
  })
})

const noWait = () => Promise.resolve()

function done(raw: object): TestRun {
  const parsed = parseConnectionTest(raw)
  if (!parsed) throw new Error('fixture')
  return { status: 'done', test: parsed }
}

describe('useConnectionTest', () => {
  it('zleca test z CSRF i odpytuje aż do wyniku', async () => {
    const replies = [test('PENDING'), test('RUNNING'), DONE]
    const calls: Array<{ url: string; method: string; csrf: string | null; body: unknown }> = []
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        csrf: new Headers(init?.headers).get('X-CSRF-Token'),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      return json(calls.length === 1 ? 202 : 200, replies[calls.length - 1])
    })
    const { result } = renderHook(() => useConnectionTest(SITE_ID, 'csrf', fetchFn, () => undefined, noWait))
    await act(() => result.current.start(TARGET))
    expect(result.current.run.status).toBe('done')
    expect(calls[0]).toEqual({
      url: `/api/sites/${SITE_ID}/connection-tests`,
      method: 'POST',
      csrf: 'csrf',
      body: { host: '192.168.1.60', port: 502, unit_id: 3, profile_id: 'simulated.hybrid-inverter', profile_version: '0.1.0' },
    })
    expect(calls.slice(1).map((c) => c.url)).toEqual([
      `/api/sites/${SITE_ID}/connection-tests/t1`,
      `/api/sites/${SITE_ID}/connection-tests/t1`,
    ])
  })

  it('wygaśnięcie po stronie serwera i po terminie w przeglądarce', async () => {
    const expired = vi.fn<typeof fetch>(async (_input, init) =>
      init?.method === 'POST' ? json(202, test('PENDING')) : json(200, test('EXPIRED')),
    )
    const a = renderHook(() => useConnectionTest(SITE_ID, 'csrf', expired, () => undefined, noWait))
    await act(() => a.result.current.start(TARGET))
    expect(a.result.current.run.status).toBe('expired')

    let now = 0
    const stuck = vi.fn<typeof fetch>(async (_input, init) =>
      json(init?.method === 'POST' ? 202 : 200, test('RUNNING')),
    )
    const tick = () => {
      now += TEST_GIVE_UP_MS / 2
      return Promise.resolve()
    }
    const b = renderHook(() => useConnectionTest(SITE_ID, 'csrf', stuck, () => undefined, tick, () => now))
    await act(() => b.result.current.start(TARGET))
    expect(b.result.current.run.status).toBe('expired')
    expect(stuck.mock.calls.length).toBeLessThan(5)
  })

  it('błąd serwera i wygasła sesja', async () => {
    const onExpired = vi.fn<() => void>()
    const conflict = vi.fn<typeof fetch>(async () => json(409, { detail: 'Test połączenia już trwa.' }))
    const a = renderHook(() => useConnectionTest(SITE_ID, 'csrf', conflict, onExpired, noWait))
    await act(() => a.result.current.start(TARGET))
    expect(a.result.current.run).toEqual({ status: 'error', message: 'Test połączenia już trwa.' })
    expect(onExpired).not.toHaveBeenCalled()

    const anonymous = vi.fn<typeof fetch>(async (_input, init) =>
      init?.method === 'POST' ? json(202, test('PENDING')) : json(401, {}),
    )
    const b = renderHook(() => useConnectionTest(SITE_ID, 'csrf', anonymous, onExpired, noWait))
    await act(() => b.result.current.start(TARGET))
    expect(onExpired).toHaveBeenCalledOnce()
  })

  it('reset przerywa oczekiwanie — późny wynik nie nadpisuje stanu', async () => {
    const release = { resolve: (): void => undefined }
    const gate = () =>
      new Promise<void>((resolve) => {
        release.resolve = resolve
      })
    const fetchFn = vi.fn<typeof fetch>(async (_input, init) =>
      init?.method === 'POST' ? json(202, test('PENDING')) : json(200, DONE),
    )
    const { result } = renderHook(() => useConnectionTest(SITE_ID, 'csrf', fetchFn, () => undefined, gate))
    let pending: Promise<void> = Promise.resolve()
    await act(async () => {
      pending = result.current.start(TARGET)
      await Promise.resolve()
    })
    act(() => result.current.reset())
    await act(async () => {
      release.resolve()
      await pending
    })
    expect(result.current.run.status).toBe('idle')
    expect(fetchFn).toHaveBeenCalledOnce()
  })
})

describe('ConnectionTestResult', () => {
  it('wynik częściowy: przyczyna, oznaczenie SIMULATED, brak odczytu to „—”', () => {
    render(<ConnectionTestResult run={done(DONE)} />)
    expect(screen.getByText(/części parametrów nie odczytano/)).toBeTruthy()
    expect(screen.getByText(/sprawdź Unit ID i zgodność profilu/)).toBeTruthy()
    expect(screen.getByLabelText('Dane symulowane')).toBeTruthy()
    expect(screen.getByText('Odczytano 1 z 2 parametrów profilu.')).toBeTruthy()
    expect(screen.getByRole('row', { name: /Moc PV/ }).textContent).toContain('1,50 kW')
    expect(screen.getByRole('row', { name: /Napięcie stringu PV 1/ }).textContent).toContain('— (brak odczytu)')
  })

  it('test nieudany i oczekiwanie na agenta', () => {
    const { rerender } = render(
      <ConnectionTestResult run={done(test('DONE', { result: 'FAILED', error_code: 'CONNECTION_REFUSED' }))} />,
    )
    expect(screen.getByText('Nie udało się odczytać urządzenia.')).toBeTruthy()
    expect(screen.getByText(/nie działa serwer Modbus TCP/)).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
    rerender(
      <ConnectionTestResult
        run={done(test('DONE', { result: 'FAILED', error_code: 'TIMEOUT', readings: [{ ...READINGS[1] }] }))}
      />,
    )
    expect(screen.getByText('Nie odczytano żadnego z 1 parametrów profilu.')).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByLabelText('Dane symulowane')).toBeNull()
    rerender(<ConnectionTestResult run={done(test('DONE', { result: 'FAILED', error_code: 'TARGET_IN_USE' }))} />)
    expect(screen.getByText('Test nie został wykonany.')).toBeTruthy()
    expect(screen.getByText(/Agent już odczytuje urządzenie pod tym adresem/)).toBeTruthy()
    expect(screen.queryByText('Nie udało się odczytać urządzenia.')).toBeNull()
    rerender(<ConnectionTestResult run={{ status: 'waiting', test: null }} />)
    expect(screen.getByRole('status').textContent).toContain('Czekam, aż agent odbierze zlecenie')
    rerender(<ConnectionTestResult run={{ status: 'expired' }} />)
    expect(screen.getByRole('alert').textContent).toContain('Agent nie wykonał testu na czas')
  })
})
