/** Pierwsza konfiguracja (D31): POST /api/setup. Tylko komunikaty bezpieczne dla użytkownika. */

export const PASSWORD_MIN = 12
export const PASSWORD_MAX = 128

export interface SetupInput {
  token: string
  organizationName: string
  displayName: string
  email: string
  password: string
}

export type SetupResult = { ok: true } | { ok: false; message: string }

const STATUS_MESSAGES: Record<number, string> = {
  400: 'Link konfiguracji jest nieprawidłowy lub wygasł. Wygeneruj nowy poleceniem instalatora.',
  409: 'System jest już skonfigurowany. Zaloguj się istniejącym kontem.',
  422: 'Sprawdź poprawność pól formularza.',
}

const GENERIC = 'Nie udało się utworzyć konta. Spróbuj ponownie za chwilę.'

async function detailOf(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json()
    if (typeof body === 'object' && body !== null && 'detail' in body) {
      const { detail } = body
      return typeof detail === 'string' ? detail : null
    }
  } catch {
    // Treść nie jest JSON-em — używamy komunikatu ogólnego.
  }
  return null
}

export async function postSetup(input: SetupInput, fetchFn: typeof fetch = fetch): Promise<SetupResult> {
  let response: Response
  try {
    response = await fetchFn('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        token: input.token,
        organization_name: input.organizationName,
        display_name: input.displayName,
        email: input.email,
        password: input.password,
      }),
    })
  } catch {
    return { ok: false, message: 'Brak połączenia z serwerem.' }
  }
  if (response.status === 201) {
    return { ok: true }
  }
  // Komunikat z API (np. o haśle) pokazujemy tylko dla błędów walidacji; inaczej stały tekst.
  const detail = response.status === 422 ? await detailOf(response) : null
  return { ok: false, message: detail ?? STATUS_MESSAGES[response.status] ?? GENERIC }
}

export interface SetupFields {
  organizationName: string
  displayName: string
  email: string
  password: string
  passwordRepeat: string
}

export type FieldErrors = Partial<Record<keyof SetupFields, string>>

export function validateSetup(fields: SetupFields): FieldErrors {
  const errors: FieldErrors = {}
  if (!fields.organizationName.trim()) errors.organizationName = 'Podaj nazwę organizacji.'
  if (!fields.displayName.trim()) errors.displayName = 'Podaj imię i nazwisko lub nazwę.'
  const email = fields.email.trim()
  const [local, domain] = email.split('@')
  if (!local || !domain?.includes('.') || email.split('@').length !== 2 || /\s/.test(email)) {
    errors.email = 'Podaj poprawny adres e-mail.'
  }
  if (fields.password.length < PASSWORD_MIN || fields.password.length > PASSWORD_MAX) {
    errors.password = `Hasło musi mieć od ${PASSWORD_MIN} do ${PASSWORD_MAX} znaków.`
  }
  if (fields.passwordRepeat !== fields.password) errors.passwordRepeat = 'Hasła nie są takie same.'
  return errors
}
