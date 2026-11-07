/** Instalacje (D33): GET/POST /api/sites. Dostęp sprawdza serwer; UI tylko ukrywa niedostępne akcje. */
import type { Role } from './auth'

export const DEFAULT_TIMEZONE = 'Europe/Warsaw'
export const NAME_MAX = 200

export interface ApiSite {
  id: string
  organizationId: string
  name: string
  timezone: string
  role: Role
}

export type ListResult = { kind: 'ok'; sites: ApiSite[] } | { kind: 'anonymous' } | { kind: 'error' }

export type CreateResult = { ok: true; site: ApiSite } | { ok: false; message: string; anonymous?: boolean }

const ROLES: ReadonlySet<string> = new Set(['OWNER', 'ADMIN', 'VIEWER'])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function parseSite(v: unknown): ApiSite | null {
  if (!isRecord(v)) return null
  const { id, organization_id: organizationId, name, timezone, role } = v
  if (
    typeof id !== 'string' ||
    typeof organizationId !== 'string' ||
    typeof name !== 'string' ||
    typeof timezone !== 'string' ||
    typeof role !== 'string' ||
    !ROLES.has(role)
  ) {
    return null
  }
  return { id, organizationId, name, timezone, role: role as Role }
}

export function parseSites(v: unknown): ApiSite[] | null {
  if (!Array.isArray(v)) return null
  const sites: ApiSite[] = []
  for (const item of v) {
    const site = parseSite(item)
    if (!site) return null
    sites.push(site)
  }
  return sites
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

export async function listSites(fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<ListResult> {
  let response: Response
  try {
    response = await fetchFn('/api/sites', { credentials: 'same-origin', ...(signal ? { signal } : {}) })
  } catch {
    return { kind: 'error' }
  }
  if (response.status === 401) return { kind: 'anonymous' }
  if (!response.ok) return { kind: 'error' }
  const sites = parseSites(await json(response))
  return sites ? { kind: 'ok', sites } : { kind: 'error' }
}

export interface SiteInput {
  organizationId: string
  name: string
  timezone: string
}

const CREATE_ERRORS: Record<number, string> = {
  403: 'Nie masz uprawnień do dodawania instalacji w tej organizacji.',
  404: 'Nie znaleziono organizacji.',
  422: 'Sprawdź nazwę i strefę czasową.',
}

export async function createSite(
  input: SiteInput,
  csrfToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<CreateResult> {
  let response: Response
  try {
    response = await fetchFn('/api/sites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      credentials: 'same-origin',
      body: JSON.stringify({
        organization_id: input.organizationId,
        name: input.name,
        timezone: input.timezone,
      }),
    })
  } catch {
    return { ok: false, message: 'Brak połączenia z serwerem.' }
  }
  if (response.status === 401) return { ok: false, message: 'Sesja wygasła.', anonymous: true }
  if (response.status === 201) {
    const site = parseSite(await json(response))
    return site ? { ok: true, site } : { ok: false, message: 'Nieoczekiwana odpowiedź serwera.' }
  }
  return { ok: false, message: CREATE_ERRORS[response.status] ?? 'Nie udało się dodać instalacji.' }
}

/** Strefy IANA z przeglądarki w postaci Obszar/Miejsce oraz UTC — to samo akceptuje serwer. */
export function timezoneOptions(): string[] {
  let zones: string[] = []
  try {
    zones = Intl.supportedValuesOf('timeZone').filter((z) => z.includes('/'))
  } catch {
    zones = []
  }
  const all = new Set([DEFAULT_TIMEZONE, 'UTC', ...zones])
  return [...all].toSorted((a, b) => a.localeCompare(b))
}

export type SiteFieldErrors = Partial<Record<'name' | 'timezone' | 'organizationId', string>>

export function validateSite(input: SiteInput, zones: readonly string[]): SiteFieldErrors {
  const errors: SiteFieldErrors = {}
  const name = input.name.trim()
  if (!name) errors.name = 'Podaj nazwę instalacji.'
  else if (name.length > NAME_MAX) errors.name = `Nazwa może mieć najwyżej ${NAME_MAX} znaków.`
  if (!zones.includes(input.timezone)) errors.timezone = 'Wybierz strefę czasową z listy.'
  if (!input.organizationId) errors.organizationId = 'Wybierz organizację.'
  return errors
}

export type GetResult = { kind: 'ok'; site: ApiSite } | { kind: 'anonymous' } | { kind: 'not-found' } | { kind: 'error' }

export async function getSite(siteId: string, fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<GetResult> {
  let response: Response
  try {
    response = await fetchFn(`/api/sites/${encodeURIComponent(siteId)}`, {
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    })
  } catch {
    return { kind: 'error' }
  }
  if (response.status === 401) return { kind: 'anonymous' }
  if (response.status === 404 || response.status === 422) return { kind: 'not-found' }
  if (!response.ok) return { kind: 'error' }
  const site = parseSite(await json(response))
  return site ? { kind: 'ok', site } : { kind: 'error' }
}
