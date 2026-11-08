/**
 * Sprawdzanie aktualizacji (D15, D63): `/api/system/updates`, tylko rola OWNER (inne role — 403).
 * Zmiany (`check`, `settings`, `dismiss`) wymagają tokenu CSRF. Aplikacja tylko informuje
 * o nowej wersji — instalacja jest ręczna.
 */

export type CheckError = 'NOT_CONFIGURED' | 'NETWORK' | 'TOO_LARGE' | 'INVALID_SIGNATURE' | 'INVALID_MANIFEST'

export interface UpdateAvailability {
  version: string
  releasedAt: string
  security: boolean
  notes: string
  /** Adres informacji o wydaniu z podpisanego manifestu; tylko HTTPS. */
  infoUrl: string
  /** `false` — bieżąca wersja jest za stara na bezpośrednią aktualizację. */
  directUpgrade: boolean
}

export interface UpdatesState {
  currentVersion: string
  /** `false` — ta wersja aplikacji nie ma klucza podpisu; sprawdzanie niemożliwe. */
  configured: boolean
  automatic: boolean
  lastCheckedAt: string | null
  lastSuccessAt: string | null
  lastError: CheckError | null
  nextCheckAt: string | null
  available: UpdateAvailability | null
  dismissed: boolean
}

export type UpdatesResult =
  | { kind: 'ok'; data: UpdatesState }
  | { kind: 'anonymous' }
  | { kind: 'forbidden' }
  | { kind: 'error' }

export type ChangeResult = { ok: true; data: UpdatesState } | { ok: false; message: string }

const ERRORS: ReadonlySet<string> = new Set([
  'NOT_CONFIGURED',
  'NETWORK',
  'TOO_LARGE',
  'INVALID_SIGNATURE',
  'INVALID_MANIFEST',
])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v))
const timeOrNull = (v: unknown): string | null | undefined => (v === null ? null : isTime(v) ? v : undefined)

function parseAvailability(v: unknown): UpdateAvailability | null | undefined {
  if (v === null) return null
  if (
    !isRecord(v) ||
    typeof v.version !== 'string' ||
    !isTime(v.released_at) ||
    typeof v.security !== 'boolean' ||
    typeof v.notes !== 'string' ||
    typeof v.info_url !== 'string' ||
    !v.info_url.startsWith('https://') ||
    typeof v.direct_upgrade !== 'boolean'
  ) {
    return undefined
  }
  return {
    version: v.version,
    releasedAt: v.released_at,
    security: v.security,
    notes: v.notes,
    infoUrl: v.info_url,
    directUpgrade: v.direct_upgrade,
  }
}

/** Walidacja odpowiedzi na granicy — nieznany kształt to błąd, nie zgadywanie. */
export function parseUpdates(v: unknown): UpdatesState | null {
  if (!isRecord(v)) return null
  const lastCheckedAt = timeOrNull(v.last_checked_at)
  const lastSuccessAt = timeOrNull(v.last_success_at)
  const nextCheckAt = timeOrNull(v.next_check_at)
  const available = parseAvailability(v.available)
  const lastError = v.last_error
  if (
    typeof v.current_version !== 'string' ||
    typeof v.configured !== 'boolean' ||
    typeof v.automatic !== 'boolean' ||
    lastCheckedAt === undefined ||
    lastSuccessAt === undefined ||
    nextCheckAt === undefined ||
    available === undefined ||
    typeof v.dismissed !== 'boolean' ||
    !(lastError === null || (typeof lastError === 'string' && ERRORS.has(lastError)))
  ) {
    return null
  }
  return {
    currentVersion: v.current_version,
    configured: v.configured,
    automatic: v.automatic,
    lastCheckedAt,
    lastSuccessAt,
    lastError: lastError as CheckError | null,
    nextCheckAt,
    available,
    dismissed: v.dismissed,
  }
}

const BASE = '/api/system/updates'

async function readBody(response: Response): Promise<UpdatesState | null> {
  try {
    return parseUpdates(await response.json())
  } catch {
    return null
  }
}

export async function getUpdates(fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<UpdatesResult> {
  let response: Response
  try {
    response = await fetchFn(BASE, { credentials: 'same-origin', ...(signal ? { signal } : {}) })
  } catch {
    return { kind: 'error' }
  }
  if (response.status === 401) return { kind: 'anonymous' }
  if (response.status === 403) return { kind: 'forbidden' }
  if (!response.ok) return { kind: 'error' }
  const data = await readBody(response)
  return data === null ? { kind: 'error' } : { kind: 'ok', data }
}

async function change(
  path: string,
  method: 'POST' | 'PUT',
  body: unknown,
  csrfToken: string,
  fetchFn: typeof fetch,
): Promise<ChangeResult> {
  const headers: Record<string, string> = { 'X-CSRF-Token': csrfToken }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  let response: Response
  try {
    response = await fetchFn(`${BASE}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  } catch {
    return { ok: false, message: 'Brak połączenia z serwerem.' }
  }
  if (response.status === 401) return { ok: false, message: 'Sesja wygasła. Zaloguj się ponownie.' }
  if (response.status === 403) return { ok: false, message: 'Tylko właściciel organizacji może to zmienić.' }
  if (response.status === 409) return { ok: false, message: 'Tej wersji nie można ukryć.' }
  if (!response.ok) return { ok: false, message: 'Nie udało się wykonać operacji.' }
  const data = await readBody(response)
  return data === null ? { ok: false, message: 'Nieoczekiwana odpowiedź serwera.' } : { ok: true, data }
}

/** Sprawdzenie teraz; serwer pozwala najwyżej raz na minutę (wcześniej zwraca ostatni wynik). */
export const checkUpdates = (csrfToken: string, fetchFn: typeof fetch = fetch): Promise<ChangeResult> =>
  change('/check', 'POST', undefined, csrfToken, fetchFn)

export const setAutomaticCheck = (
  automatic: boolean,
  csrfToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<ChangeResult> => change('/settings', 'PUT', { automatic }, csrfToken, fetchFn)

/** Ukrycie zwykłej wersji dla wszystkich właścicieli; wersji z poprawkami bezpieczeństwa — 409. */
export const dismissUpdate = (version: string, csrfToken: string, fetchFn: typeof fetch = fetch): Promise<ChangeResult> =>
  change('/dismiss', 'POST', { version }, csrfToken, fetchFn)
