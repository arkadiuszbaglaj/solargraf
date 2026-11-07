import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SessionProvider } from '../auth/SessionContext'
import { Topbar } from './Topbar'

const props = {
  sites: [{ id: 's1', name: 'Dom', timezone: 'Europe/Warsaw' }],
  siteId: 's1',
  onSiteChange: () => undefined,
  now: new Date('2026-11-07T11:00:00Z'),
  origin: 'DEMO' as const,
  menuOpen: false,
  onToggleMenu: () => undefined,
  menuId: 'menu',
}

const session = {
  user: { id: 'u1', email: 'jan@example.pl', displayName: 'Jan Kowalski' },
  memberships: [],
  csrfToken: 'csrf',
}

describe('Topbar', () => {
  it('bez sesji nie pokazuje użytkownika', () => {
    render(<Topbar {...props} />)
    expect(screen.queryByRole('button', { name: /Wyloguj/ })).toBeNull()
  })

  it('pokazuje zalogowanego użytkownika i wylogowuje klawiaturą', async () => {
    const logout = vi.fn<() => void>()
    render(
      <SessionProvider value={{ session, logout, loggingOut: false }}>
        <Topbar {...props} />
      </SessionProvider>,
    )
    expect(screen.getByText('Jan Kowalski')).toBeTruthy()
    const user = userEvent.setup()
    screen.getByRole('button', { name: 'Wyloguj' }).focus()
    await user.keyboard('{Enter}')
    expect(logout).toHaveBeenCalledOnce()
  })

  it('blokuje przycisk w trakcie wylogowania', () => {
    render(
      <SessionProvider value={{ session, logout: () => undefined, loggingOut: true }}>
        <Topbar {...props} />
      </SessionProvider>,
    )
    expect((screen.getByRole('button', { name: 'Wylogowywanie…' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
