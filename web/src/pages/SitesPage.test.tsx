import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Session } from '../api/auth'
import { parseSites, timezoneOptions, validateSite } from '../api/sites'
import { SessionProvider } from '../auth/SessionContext'
import { routeFor } from '../Root'
import { SitesPage } from './SitesPage'

const SITE = { id: 's1', organization_id: 'o1', name: 'Dom', timezone: 'Europe/Warsaw', role: 'OWNER' }

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

function session(role: 'OWNER' | 'ADMIN' | 'VIEWER', orgs = 1): Session {
  return {
    user: { id: 'u1', email: 'jan@example.pl', displayName: 'Jan' },
    memberships: Array.from({ length: orgs }, (_, i) => ({
      organizationId: `o${i + 1}`,
      organizationName: `Org ${i + 1}`,
      role,
    })),
    csrfToken: 'csrf',
  }
}

function renderPage(fetchFn: typeof fetch, s: Session | null = session('OWNER'), navigate = vi.fn<(u: string) => void>()) {
  const page = <SitesPage fetchFn={fetchFn} navigate={navigate} />
  render(s ? <SessionProvider value={{ session: s, logout: () => undefined, loggingOut: false }}>{page}</SessionProvider> : page)
  return navigate
}

describe('api/sites', () => {
  it('waliduje odpowiedź listy', () => {
    expect(parseSites([SITE])).toEqual([
      { id: 's1', organizationId: 'o1', name: 'Dom', timezone: 'Europe/Warsaw', role: 'OWNER' },
    ])
    expect(parseSites([{ ...SITE, role: 'ROOT' }])).toBeNull()
    expect(parseSites({})).toBeNull()
  })

  it('lista stref zawiera domyślną i UTC, bez skrótów typu CET', () => {
    const zones = timezoneOptions()
    expect(zones).toContain('Europe/Warsaw')
    expect(zones).toContain('UTC')
    expect(zones.every((z) => z === 'UTC' || z.includes('/'))).toBe(true)
  })

  it('walidacja formularza', () => {
    const zones = ['Europe/Warsaw']
    expect(validateSite({ organizationId: 'o1', name: 'Dom', timezone: 'Europe/Warsaw' }, zones)).toEqual({})
    const bad = validateSite({ organizationId: '', name: '  ', timezone: 'Mars/Olympus' }, zones)
    expect(Object.keys(bad).toSorted()).toEqual(['name', 'organizationId', 'timezone'])
    expect(validateSite({ organizationId: 'o1', name: 'x'.repeat(201), timezone: 'Europe/Warsaw' }, zones).name).toBeDefined()
  })
})

describe('SitesPage', () => {
  it('pokazuje instalacje w tabeli z rolą', async () => {
    renderPage(vi.fn<typeof fetch>().mockResolvedValue(json(200, [SITE])))
    const row = (await screen.findByRole('cell', { name: 'Dom' })).closest('tr')
    expect(row && within(row).getByText('Właściciel')).toBeTruthy()
    expect(screen.getByText(/dashboard pokazuje dane DEMO/)).toBeTruthy()
  })

  it('pusty stan zachęca do dodania pierwszej instalacji', async () => {
    renderPage(vi.fn<typeof fetch>().mockResolvedValue(json(200, [])))
    expect(await screen.findByText(/Brak instalacji/)).toBeTruthy()
  })

  it('błąd serwera pozwala ponowić', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(json(500, {})).mockResolvedValueOnce(json(200, [SITE]))
    renderPage(fetchFn)
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Spróbuj ponownie' }))
    expect(await screen.findByRole('cell', { name: 'Dom' })).toBeTruthy()
  })

  it('wygasła sesja przekierowuje na logowanie', async () => {
    const navigate = renderPage(vi.fn<typeof fetch>().mockResolvedValue(json(401, {})))
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.stringContaining('reason=expired')))
  })

  it('VIEWER nie widzi formularza dodawania', async () => {
    renderPage(vi.fn<typeof fetch>().mockResolvedValue(json(200, [SITE])), session('VIEWER'))
    await screen.findByRole('cell', { name: 'Dom' })
    expect(screen.queryByRole('button', { name: 'Dodaj instalację' })).toBeNull()
  })

  it('dodaje instalację z CSRF i odświeża listę', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(200, []))
      .mockResolvedValueOnce(json(201, { ...SITE, name: 'Garaż' }))
      .mockResolvedValueOnce(json(200, [{ ...SITE, name: 'Garaż' }]))
    renderPage(fetchFn)
    const user = userEvent.setup()
    await screen.findByText(/Brak instalacji/)
    await user.type(screen.getByLabelText('Nazwa'), '  Garaż  ')
    await user.click(screen.getByRole('button', { name: 'Dodaj instalację' }))
    expect((await screen.findByRole('status')).textContent).toBe('Dodano instalację „Garaż”.')
    const [url, init] = fetchFn.mock.calls[1] ?? []
    expect(url).toBe('/api/sites')
    expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('csrf')
    expect(JSON.parse(String(init?.body))).toEqual({ organization_id: 'o1', name: 'Garaż', timezone: 'Europe/Warsaw' })
    expect(await screen.findByRole('cell', { name: 'Garaż' })).toBeTruthy()
  })

  it('nie wysyła formularza z nieznaną strefą i oznacza pole', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(json(200, []))
    renderPage(fetchFn)
    const user = userEvent.setup()
    await screen.findByText(/Brak instalacji/)
    await user.type(screen.getByLabelText('Nazwa'), 'Dom')
    const tz = screen.getByLabelText('Strefa czasowa')
    await user.clear(tz)
    await user.type(tz, 'Mars/Olympus')
    await user.click(screen.getByRole('button', { name: 'Dodaj instalację' }))
    expect(tz.getAttribute('aria-invalid')).toBe('true')
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it('pokazuje odmowę serwera (np. zawężony ADMIN)', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(json(200, [])).mockResolvedValueOnce(json(403, {}))
    renderPage(fetchFn, session('ADMIN'))
    const user = userEvent.setup()
    await screen.findByText(/Brak instalacji/)
    await user.type(screen.getByLabelText('Nazwa'), 'Dom')
    await user.click(screen.getByRole('button', { name: 'Dodaj instalację' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Nie masz uprawnień')
  })

  it('przy kilku organizacjach pozwala wybrać organizację', async () => {
    renderPage(vi.fn<typeof fetch>().mockResolvedValue(json(200, [])), session('OWNER', 2))
    await screen.findByText(/Brak instalacji/)
    expect(screen.getByLabelText('Organizacja')).toBeTruthy()
  })

  it('ścieżka /instalacje prowadzi do tej strony', () => {
    expect(routeFor('/instalacje')).toBe('sites')
  })
})
