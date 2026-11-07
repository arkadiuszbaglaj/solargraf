import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { LoginResult } from '../api/auth'
import { LoginPage } from './LoginPage'

const SESSION = {
  user: { id: 'u1', email: 'jan@example.pl', displayName: 'Jan' },
  memberships: [],
  csrfToken: 'csrf',
}

type Submit = (email: string, password: string) => Promise<LoginResult>

describe('LoginPage', () => {
  it('loguje i przechodzi do bezpiecznej ścieżki', async () => {
    const submit = vi.fn<Submit>().mockResolvedValue({ ok: true, session: SESSION })
    const navigate = vi.fn<(url: string) => void>()
    render(<LoginPage initialEmail="jan@example.pl" next="/historia" submit={submit} navigate={navigate} />)
    const user = userEvent.setup()
    expect((screen.getByLabelText('E-mail') as HTMLInputElement).value).toBe('jan@example.pl')
    await user.type(screen.getByLabelText('Hasło'), 'bardzo-dlugie-haslo{Enter}')
    expect(submit).toHaveBeenCalledWith('jan@example.pl', 'bardzo-dlugie-haslo')
    expect(navigate).toHaveBeenCalledWith('/historia')
  })

  it('nie przekierowuje na inny host', async () => {
    const submit = vi.fn<Submit>().mockResolvedValue({ ok: true, session: SESSION })
    const navigate = vi.fn<(url: string) => void>()
    render(<LoginPage initialEmail="a@b.pl" next="//zly.example" submit={submit} navigate={navigate} />)
    await userEvent.setup().type(screen.getByLabelText('Hasło'), 'x{Enter}')
    expect(navigate).toHaveBeenCalledWith('/')
  })

  it('pokazuje błąd i czyści hasło', async () => {
    const submit = vi.fn<Submit>().mockResolvedValue({ ok: false, message: 'Nieprawidłowy e-mail lub hasło.' })
    const navigate = vi.fn<(url: string) => void>()
    render(<LoginPage initialEmail="a@b.pl" submit={submit} navigate={navigate} />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Hasło'), 'zle{Enter}')
    expect((await screen.findByRole('alert')).textContent).toBe('Nieprawidłowy e-mail lub hasło.')
    expect((screen.getByLabelText('Hasło') as HTMLInputElement).value).toBe('')
    expect(navigate).not.toHaveBeenCalled()
  })

  it('wymaga obu pól bez wysyłania żądania', async () => {
    const submit = vi.fn<Submit>()
    render(<LoginPage submit={submit} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Zaloguj się' }))
    expect(screen.getByRole('alert').textContent).toBe('Podaj e-mail i hasło.')
    expect(submit).not.toHaveBeenCalled()
  })

  it('informuje o wygasłej sesji', () => {
    render(<LoginPage expired />)
    expect(screen.getByRole('status').textContent).toContain('Sesja wygasła')
  })
})
