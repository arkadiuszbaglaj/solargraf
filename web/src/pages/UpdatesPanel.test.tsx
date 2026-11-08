import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Role, Session } from '../api/auth'
import { checkUpdates, dismissUpdate, getUpdates, parseUpdates, setAutomaticCheck } from '../api/updates'
import { SessionProvider } from '../auth/SessionContext'
import { UpdateBanner } from '../layout/UpdateBanner'
import { clearPostponed } from '../lib/updates'
import { UpdatesPanel } from './UpdatesPanel'

// Wartości testowe — nie pochodzą z prawdziwego wydania.
const BASE = {
  current_version: '0.1.0',
  configured: true,
  automatic: true,
  last_checked_at: '2026-11-07T11:00:00Z',
  last_success_at: '2026-11-07T11:00:00Z',
  last_error: null,
  next_check_at: '2026-11-14T11:00:00Z',
  available: null,
  dismissed: false,
}

const AVAILABLE = {
  version: '0.2.0',
  released_at: '2026-11-06T10:00:00Z',
  security: false,
  notes: 'Poprawki wykresów.',
  info_url: 'https://example.com/wydanie',
  direct_upgrade: true,
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
const reply = (status: number) => vi.fn<typeof fetch>(() => Promise.resolve(json(status, {})))

/** Atrapa: GET zwraca `get`, zmiany — kolejne odpowiedzi z `changes`. */
function api(get: unknown, ...changes: Array<[number, unknown]>) {
  const queue = [...changes]
  return vi.fn<typeof fetch>((_input, init) => {
    if (init?.method === undefined) return Promise.resolve(json(200, get))
    const [status, body] = queue.shift() ?? [500, {}]
    return Promise.resolve(json(status, body))
  })
}

function session(role: Role): Session {
  return {
    user: { id: 'u1', email: 'jan@example.pl', displayName: 'Jan' },
    memberships: [{ organizationId: 'o1', organizationName: 'Org', role }],
    csrfToken: 'csrf',
  }
}

function withSession(role: Role, children: React.ReactNode) {
  return (
    <SessionProvider value={{ session: session(role), logout: vi.fn<() => void>(), loggingOut: false }}>
      {children}
    </SessionProvider>
  )
}

const renderPanel = (fetchFn: typeof fetch, onExpired = vi.fn<() => void>()) => {
  render(withSession('OWNER', <UpdatesPanel fetchFn={fetchFn} onExpired={onExpired} timeZone="Europe/Warsaw" />))
  return onExpired
}

function dd(label: string): string {
  const term = screen.getByText(label, { selector: 'dt' })
  return term.nextElementSibling?.textContent ?? ''
}

afterEach(() => clearPostponed())

describe('parseUpdates', () => {
  it('przyjmuje stan z dostępną wersją i bez niej', () => {
    expect(parseUpdates(BASE)?.available).toBeNull()
    const parsed = parseUpdates({ ...BASE, available: AVAILABLE })
    expect(parsed?.available?.version).toBe('0.2.0')
    expect(parsed?.available?.directUpgrade).toBe(true)
  })

  it('odrzuca nieznany błąd, adres bez HTTPS i zły czas', () => {
    expect(parseUpdates({ ...BASE, last_error: 'TIMEOUT' })).toBeNull()
    expect(parseUpdates({ ...BASE, available: { ...AVAILABLE, info_url: 'http://example.com' } })).toBeNull()
    expect(parseUpdates({ ...BASE, last_checked_at: 'wczoraj' })).toBeNull()
    expect(parseUpdates({ ...BASE, configured: 'tak' })).toBeNull()
  })
})

describe('klient API', () => {
  it('rozróżnia 401, 403 i błąd', async () => {
    expect((await getUpdates(reply(401))).kind).toBe('anonymous')
    expect((await getUpdates(reply(403))).kind).toBe('forbidden')
    expect((await getUpdates(reply(500))).kind).toBe('error')
  })

  it('zmiany wysyłają token CSRF, metodę i treść', async () => {
    const fetchFn = vi.fn<typeof fetch>(() => Promise.resolve(json(200, BASE)))
    await checkUpdates('t1', fetchFn)
    await setAutomaticCheck(false, 't2', fetchFn)
    await dismissUpdate('0.2.0', 't3', fetchFn)
    const calls = fetchFn.mock.calls.map(([url, init]) => [
      String(url),
      init?.method,
      (init?.headers as Record<string, string> | undefined)?.['X-CSRF-Token'],
      init?.body,
    ])
    expect(calls).toEqual([
      ['/api/system/updates/check', 'POST', 't1', undefined],
      ['/api/system/updates/settings', 'PUT', 't2', '{"automatic":false}'],
      ['/api/system/updates/dismiss', 'POST', 't3', '{"version":"0.2.0"}'],
    ])
  })

  it('409 przy ukrywaniu to czytelny komunikat', async () => {
    const result = await dismissUpdate('0.2.0', 't', vi.fn<typeof fetch>(() => Promise.resolve(json(409, {}))))
    expect(result).toEqual({ ok: false, message: 'Tej wersji nie można ukryć.' })
  })
})

describe('UpdatesPanel', () => {
  it('aktualna wersja: daty sprawdzeń i ustawienie', async () => {
    renderPanel(api(BASE))
    expect(await screen.findByText('Masz najnowszą wersję.')).toBeTruthy()
    expect(dd('Zainstalowana wersja')).toBe('0.1.0')
    expect(dd('Ostatnie sprawdzenie')).toBe(dd('Ostatnie udane sprawdzenie'))
    expect(screen.getByRole('checkbox', { name: /Sprawdzaj automatycznie/ })).toHaveProperty('checked', true)
  })

  it('dostępna wersja z opisem, odnośnikiem i ostrzeżeniem o aktualizacji pośredniej', async () => {
    renderPanel(api({ ...BASE, available: { ...AVAILABLE, security: true, direct_upgrade: false } }))
    expect(await screen.findByText('Dostępna wersja 0.2.0')).toBeTruthy()
    expect(screen.getByText('Poprawki bezpieczeństwa')).toBeTruthy()
    expect(screen.getByText('Poprawki wykresów.')).toBeTruthy()
    expect(screen.getByText(/aktualizacji pośredniej/)).toBeTruthy()
    const link = screen.getByRole('link', { name: 'Informacje o wydaniu' })
    expect(link.getAttribute('href')).toBe('https://example.com/wydanie')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('błąd sprawdzenia: opis bez szczegółów i data ostatniego sukcesu', async () => {
    renderPanel(api({ ...BASE, last_checked_at: '2026-11-08T11:00:00Z', last_error: 'NETWORK' }))
    expect(await screen.findByText(/Nie udało się sprawdzić: brak połączenia/)).toBeTruthy()
    expect(dd('Ostatnie udane sprawdzenie')).not.toBe('brak')
  })

  it('brak klucza: tylko wersja i informacja, bez przycisków', async () => {
    renderPanel(api({ ...BASE, configured: false, last_checked_at: null, last_success_at: null }))
    expect(await screen.findByText(/nie ma skonfigurowanego sprawdzania/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sprawdź aktualizacje' })).toBeNull()
    expect(screen.queryByText('Ostatnie sprawdzenie')).toBeNull()
  })

  it('ręczne sprawdzenie pokazuje nową wersję', async () => {
    const after = { ...BASE, last_checked_at: '2026-11-08T12:00:00Z', available: AVAILABLE }
    const fetchFn = api(BASE, [200, after])
    renderPanel(fetchFn)
    await userEvent.click(await screen.findByRole('button', { name: 'Sprawdź aktualizacje' }))
    expect(await screen.findByText('Dostępna wersja 0.2.0')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Sprawdzono.')
  })

  it('zbyt częste sprawdzenie: komunikat o limicie', async () => {
    renderPanel(api(BASE, [200, BASE]))
    await userEvent.click(await screen.findByRole('button', { name: 'Sprawdź aktualizacje' }))
    expect(await screen.findByText(/kolejne sprawdzenie będzie możliwe za minutę/)).toBeTruthy()
  })

  it('wyłączenie automatycznego sprawdzania', async () => {
    const fetchFn = api(BASE, [200, { ...BASE, automatic: false, next_check_at: null }])
    renderPanel(fetchFn)
    await userEvent.click(await screen.findByRole('checkbox', { name: /Sprawdzaj automatycznie/ }))
    expect(await screen.findByText('Automatyczne sprawdzanie wyłączone.')).toBeTruthy()
    expect(dd('Następne automatyczne')).toBe('wyłączone')
    expect(screen.getByRole('checkbox', { name: /Sprawdzaj automatycznie/ })).toHaveProperty('checked', false)
  })

  it('błąd zmiany pokazuje komunikat i zostawia stan', async () => {
    renderPanel(api(BASE, [403, {}]))
    await userEvent.click(await screen.findByRole('checkbox', { name: /Sprawdzaj automatycznie/ }))
    expect(await screen.findByText(/Tylko właściciel/)).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: /Sprawdzaj automatycznie/ })).toHaveProperty('checked', true)
  })

  it('401 — przekierowanie do logowania', async () => {
    const fetchFn = vi.fn<typeof fetch>(() => Promise.resolve(json(401, {})))
    const onExpired = renderPanel(fetchFn)
    await screen.findByRole('alert')
    expect(onExpired).toHaveBeenCalled()
  })
})

describe('UpdateBanner', () => {
  it('nie pobiera stanu dla innych ról', () => {
    const fetchFn = api({ ...BASE, available: AVAILABLE })
    render(withSession('ADMIN', <UpdateBanner fetchFn={fetchFn} />))
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('brak nowej wersji albo wersja ukryta — brak banera', async () => {
    const fetchFn = api({ ...BASE, available: AVAILABLE, dismissed: true })
    render(withSession('OWNER', <UpdateBanner fetchFn={fetchFn} />))
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalled())
    expect(screen.queryByText(/Dostępna jest wersja/)).toBeNull()
  })

  it('zwykła wersja: ukrycie zapisuje się na serwerze', async () => {
    const fetchFn = api({ ...BASE, available: AVAILABLE }, [200, { ...BASE, available: AVAILABLE, dismissed: true }])
    render(withSession('OWNER', <UpdateBanner fetchFn={fetchFn} />))
    expect(await screen.findByText('Dostępna jest wersja 0.2.0.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Szczegóły i instrukcja' }).getAttribute('href')).toBe(
      '/ustawienia/serwer',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Nie pokazuj dla tej wersji' }))
    expect(screen.queryByText(/Dostępna jest wersja/)).toBeNull()
    expect(fetchFn.mock.calls.some(([url]) => String(url) === '/api/system/updates/dismiss')).toBe(true)
  })

  it('wersja z poprawkami bezpieczeństwa: tylko odłożenie do kolejnego logowania', async () => {
    const security = { ...BASE, available: { ...AVAILABLE, security: true } }
    const fetchFn = api(security)
    const { unmount } = render(withSession('OWNER', <UpdateBanner fetchFn={fetchFn} />))
    expect(await screen.findByText('Dostępna jest wersja 0.2.0 z poprawkami bezpieczeństwa.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Nie pokazuj dla tej wersji' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Przypomnij przy następnym logowaniu' }))
    expect(screen.queryByText(/Dostępna jest wersja/)).toBeNull()
    expect(fetchFn.mock.calls.every(([, init]) => init?.method === undefined)).toBe(true)
    unmount()

    // Ta sama sesja karty: nadal odłożone (wylogowanie czyści odłożenie — clearPostponed).
    render(withSession('OWNER', <UpdateBanner fetchFn={fetchFn} />))
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2))
    expect(screen.queryByText(/Dostępna jest wersja/)).toBeNull()
    clearPostponed()
  })
})
