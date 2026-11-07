import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SetupInput, SetupResult } from '../api/setup'
import { postSetup, validateSetup } from '../api/setup'
import { SetupPage, takeTokenFromLocation } from './SetupPage'

const VALID = {
  organizationName: 'Dom',
  displayName: 'Jan Kowalski',
  email: 'jan@example.pl',
  password: 'bardzo-dlugie-haslo',
  passwordRepeat: 'bardzo-dlugie-haslo',
}

async function fill(values: Partial<typeof VALID> = VALID) {
  const user = userEvent.setup()
  const labels: Record<keyof typeof VALID, string> = {
    organizationName: 'Nazwa organizacji',
    displayName: 'Imię i nazwisko',
    email: 'E-mail (login)',
    password: 'Hasło',
    passwordRepeat: 'Powtórz hasło',
  }
  for (const [key, value] of Object.entries(values)) {
    // Pisanie w pola musi być sekwencyjne (jeden fokus klawiatury).
    // oxlint-disable-next-line no-await-in-loop
    await user.type(screen.getByLabelText(labels[key as keyof typeof VALID]), value)
  }
  return user
}

describe('validateSetup', () => {
  it('akceptuje poprawne dane', () => {
    expect(validateSetup(VALID)).toEqual({})
  })

  it('wymaga hasła 12–128 znaków i zgodnego powtórzenia', () => {
    const errors = validateSetup({ ...VALID, password: 'krotkie', passwordRepeat: 'inne' })
    expect(errors.password).toContain('12')
    expect(errors.passwordRepeat).toBe('Hasła nie są takie same.')
    expect(validateSetup({ ...VALID, password: 'x'.repeat(129), passwordRepeat: 'x'.repeat(129) }).password).toBeDefined()
  })

  it.each(['bez-malpy.pl', 'a@b', 'a b@example.pl', '@example.pl', 'a@@example.pl'])(
    'odrzuca e-mail %s',
    (email) => {
      expect(validateSetup({ ...VALID, email }).email).toBeDefined()
    },
  )
})

describe('postSetup', () => {
  const input: SetupInput = { token: 't', organizationName: 'Dom', displayName: 'Jan', email: 'j@e.pl', password: 'p' }

  it('wysyła pola w formacie API', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 201 }))
    expect(await postSetup(input, fetchFn)).toEqual({ ok: true })
    const [url, init] = fetchFn.mock.calls[0] ?? []
    expect(url).toBe('/api/setup')
    expect(JSON.parse(String(init?.body))).toEqual({
      token: 't',
      organization_name: 'Dom',
      display_name: 'Jan',
      email: 'j@e.pl',
      password: 'p',
    })
  })

  it('nie pokazuje treści błędów innych niż walidacja', async () => {
    const body = JSON.stringify({ detail: 'szczegóły wewnętrzne' })
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 500 }))
    const result = await postSetup(input, fetchFn)
    expect(result).toEqual({ ok: false, message: expect.not.stringContaining('wewnętrzne') as unknown })
  })

  it('mapuje wygasły token i brak połączenia', async () => {
    const expired = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 400 }))
    expect(await postSetup(input, expired)).toEqual({ ok: false, message: expect.stringContaining('wygasł') as unknown })
    const offline = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('network'))
    expect(await postSetup(input, offline)).toEqual({ ok: false, message: 'Brak połączenia z serwerem.' })
  })
})

describe('SetupPage', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/')
  })

  it('usuwa token z paska adresu', () => {
    window.history.replaceState(null, '', '/setup?token=sekretny')
    expect(takeTokenFromLocation()).toBe('sekretny')
    expect(window.location.search).toBe('')
    expect(window.location.pathname).toBe('/setup')
  })

  it('bez tokenu pokazuje komunikat zamiast formularza', () => {
    render(<SetupPage token="" />)
    expect(screen.getByRole('alert').textContent).toContain('Brak tokenu')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('nie wysyła formularza z błędami i oznacza pola', async () => {
    const submit = vi.fn<(i: SetupInput) => Promise<SetupResult>>()
    render(<SetupPage token="t" submit={submit} />)
    const user = await fill({ ...VALID, passwordRepeat: 'inne-haslo-123' })
    await user.click(screen.getByRole('button', { name: 'Utwórz konto właściciela' }))
    expect(submit).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Powtórz hasło').getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('Hasła nie są takie same.')).toBeTruthy()
  })

  it('wysyła dane z tokenem i pokazuje potwierdzenie', async () => {
    const submit = vi.fn<(i: SetupInput) => Promise<SetupResult>>().mockResolvedValue({ ok: true })
    render(<SetupPage token="tok" submit={submit} />)
    const user = await fill({ ...VALID, organizationName: '  Dom  ' })
    await user.keyboard('{Enter}')
    expect(submit).toHaveBeenCalledWith({
      token: 'tok',
      organizationName: 'Dom',
      displayName: 'Jan Kowalski',
      email: 'jan@example.pl',
      password: 'bardzo-dlugie-haslo',
    })
    expect((await screen.findByRole('status')).textContent).toContain('zostało utworzone')
  })

  it('pokazuje błąd serwera i pozwala poprawić dane', async () => {
    const submit = vi
      .fn<(i: SetupInput) => Promise<SetupResult>>()
      .mockResolvedValue({ ok: false, message: 'System jest już skonfigurowany.' })
    render(<SetupPage token="tok" submit={submit} />)
    const user = await fill()
    await user.click(screen.getByRole('button', { name: 'Utwórz konto właściciela' }))
    expect((await screen.findByRole('alert')).textContent).toBe('System jest już skonfigurowany.')
    expect(screen.getByRole('button', { name: 'Utwórz konto właściciela' })).toBeTruthy()
  })
})
