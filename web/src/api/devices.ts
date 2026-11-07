/**
 * Urządzenia instalacji i katalog profili (D38, D44). Odpowiedzi walidowane; dostęp sprawdza serwer,
 * UI tylko ukrywa niedostępne akcje.
 */

export type DeviceStatus = 'OK' | 'STALE' | 'ERROR' | 'UNKNOWN' | 'DISABLED'

export interface ApiConnection {
  id: string
  name: string
  host: string | null
  port: number | null
  unitId: number | null
  pollIntervalSeconds: number | null
}

/** Metryka z profilu urządzenia (D47), widoczna dla każdej roli. */
export interface ApiDeviceMetric {
  key: string
  channel: number | null
  name: string
  unit: string
  cumulative: boolean
}

export interface ApiDevice {
  id: string
  name: string
  kind: string
  manufacturer: string | null
  model: string | null
  enabled: boolean
  status: DeviceStatus
  lastSuccessAt: string | null
  details: { profileId: string | null; profileVersion: string | null; connection: ApiConnection } | null
  metrics: ApiDeviceMetric[]
}

export interface ApiProfile {
  id: string
  version: string
  name: string
  manufacturer: string
  deviceKind: string
  simulated: boolean
  supportLevel: string
  modbusTcp: boolean
  pollIntervalSeconds: number
}

export type Loaded<T> = { kind: 'ok'; data: T } | { kind: 'anonymous' } | { kind: 'error' }
export type Written<T> = { ok: true; data: T } | { ok: false; message: string; anonymous?: boolean }

const STATUSES: ReadonlySet<string> = new Set(['OK', 'STALE', 'ERROR', 'UNKNOWN', 'DISABLED'])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const strOrNull = (v: unknown): string | null | undefined =>
  v === null ? null : typeof v === 'string' ? v : undefined
const intOrNull = (v: unknown): number | null | undefined =>
  v === null ? null : Number.isInteger(v) ? (v as number) : undefined

function parseConnection(v: unknown): ApiConnection | null {
  if (!isRecord(v) || typeof v.id !== 'string' || typeof v.name !== 'string') return null
  const host = strOrNull(v.host)
  const port = intOrNull(v.port)
  const unitId = intOrNull(v.unit_id)
  const interval = intOrNull(v.poll_interval_seconds)
  if (host === undefined || port === undefined || unitId === undefined || interval === undefined) return null
  return { id: v.id, name: v.name, host, port, unitId, pollIntervalSeconds: interval }
}

function parseMetric(v: unknown): ApiDeviceMetric | null {
  if (!isRecord(v)) return null
  const { key, channel, name, unit, cumulative } = v
  if (
    typeof key !== 'string' ||
    !(channel === null || Number.isInteger(channel)) ||
    typeof name !== 'string' ||
    typeof unit !== 'string' ||
    typeof cumulative !== 'boolean'
  ) {
    return null
  }
  return { key, channel: channel as number | null, name, unit, cumulative }
}

export function parseDevice(v: unknown): ApiDevice | null {
  if (!isRecord(v)) return null
  const { id, name, kind, enabled, status } = v
  const manufacturer = strOrNull(v.manufacturer)
  const model = strOrNull(v.model)
  const lastSuccessAt = strOrNull(v.last_success_at)
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof kind !== 'string' ||
    typeof enabled !== 'boolean' ||
    typeof status !== 'string' ||
    !STATUSES.has(status) ||
    manufacturer === undefined ||
    model === undefined ||
    lastSuccessAt === undefined
  ) {
    return null
  }
  let details: ApiDevice['details'] = null
  if (v.details !== null) {
    if (!isRecord(v.details)) return null
    const profileId = strOrNull(v.details.profile_id)
    const profileVersion = strOrNull(v.details.profile_version)
    const connection = parseConnection(v.details.connection)
    if (profileId === undefined || profileVersion === undefined || !connection) return null
    details = { profileId, profileVersion, connection }
  }
  // Starsze odpowiedzi bez pola `metrics` traktujemy jak brak metryk.
  const metrics = v.metrics === undefined ? [] : parseList(v.metrics, parseMetric)
  if (metrics === null) return null
  return {
    id,
    name,
    kind,
    manufacturer,
    model,
    enabled,
    status: status as DeviceStatus,
    lastSuccessAt,
    details,
    metrics,
  }
}

export function parseProfile(v: unknown): ApiProfile | null {
  if (!isRecord(v)) return null
  const { id, version, name, manufacturer, device_kind: kind, origin, support_level: level } = v
  const interval = v.poll_interval_seconds
  if (
    typeof id !== 'string' ||
    typeof version !== 'string' ||
    typeof name !== 'string' ||
    typeof manufacturer !== 'string' ||
    typeof kind !== 'string' ||
    (origin !== 'DEVICE' && origin !== 'SIMULATED') ||
    typeof level !== 'string' ||
    !Array.isArray(v.transports) ||
    !Number.isInteger(interval)
  ) {
    return null
  }
  return {
    id,
    version,
    name,
    manufacturer,
    deviceKind: kind,
    simulated: origin === 'SIMULATED',
    supportLevel: level,
    modbusTcp: v.transports.includes('MODBUS_TCP'),
    pollIntervalSeconds: interval as number,
  }
}

function parseList<T>(v: unknown, parse: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(v)) return null
  const out: T[] = []
  for (const item of v) {
    const parsed = parse(item)
    if (!parsed) return null
    out.push(parsed)
  }
  return out
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

async function load<T>(
  url: string,
  parse: (v: unknown) => T | null,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<Loaded<T>> {
  let response: Response
  try {
    response = await fetchFn(url, { credentials: 'same-origin', ...(signal ? { signal } : {}) })
  } catch {
    return { kind: 'error' }
  }
  if (response.status === 401) return { kind: 'anonymous' }
  if (!response.ok) return { kind: 'error' }
  const data = parse(await json(response))
  return data === null ? { kind: 'error' } : { kind: 'ok', data }
}

const site = (siteId: string) => `/api/sites/${encodeURIComponent(siteId)}`

export const listDevices = (siteId: string, fetchFn: typeof fetch = fetch, signal?: AbortSignal) =>
  load(`${site(siteId)}/devices`, (v) => parseList(v, parseDevice), fetchFn, signal)

export const listProfiles = (fetchFn: typeof fetch = fetch, signal?: AbortSignal) =>
  load('/api/profiles', (v) => parseList(v, parseProfile), fetchFn, signal)

/** Komunikat serwera (`detail` tekstem) albo ogólny — bez szczegółów technicznych walidacji. */
async function failure(response: Response, fallback: string): Promise<Written<never>> {
  if (response.status === 401) return { ok: false, message: 'Sesja wygasła.', anonymous: true }
  if (response.status === 403) return { ok: false, message: 'Nie masz uprawnień do zmiany urządzeń tej instalacji.' }
  if (response.status === 404) return { ok: false, message: 'Nie znaleziono instalacji lub urządzenia.' }
  const body = await json(response)
  if (isRecord(body) && typeof body.detail === 'string') return { ok: false, message: body.detail }
  if (isRecord(body) && Array.isArray(body.detail)) {
    const first: unknown = body.detail[0]
    if (isRecord(first) && typeof first.msg === 'string') {
      return { ok: false, message: first.msg.replace(/^Value error, /, '') }
    }
  }
  return { ok: false, message: fallback }
}

async function write<T>(
  url: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  csrfToken: string,
  body: unknown,
  parse: (v: unknown) => T | null,
  fallback: string,
  fetchFn: typeof fetch,
): Promise<Written<T>> {
  let response: Response
  try {
    response = await fetchFn(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      credentials: 'same-origin',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch {
    return { ok: false, message: 'Brak połączenia z serwerem.' }
  }
  if (!response.ok) return failure(response, fallback)
  const data = parse(await json(response))
  return data === null ? { ok: false, message: 'Nieoczekiwana odpowiedź serwera.' } : { ok: true, data }
}

export interface NewConnection {
  name: string
  host: string
  port: number
  unitId: number
  pollIntervalSeconds: number | null
  deviceName: string
  profileId: string
  profileVersion: string
}

export function createConnection(
  siteId: string,
  input: NewConnection,
  csrfToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<Written<ApiDevice>> {
  return write(
    `${site(siteId)}/connections`,
    'POST',
    csrfToken,
    {
      name: input.name,
      host: input.host,
      port: input.port,
      unit_id: input.unitId,
      poll_interval_seconds: input.pollIntervalSeconds,
      device: { name: input.deviceName, profile_id: input.profileId, profile_version: input.profileVersion },
    },
    (v) => (isRecord(v) ? parseDevice(v.device) : null),
    'Nie udało się dodać urządzenia.',
    fetchFn,
  )
}

export function setDeviceEnabled(
  siteId: string,
  deviceId: string,
  enabled: boolean,
  csrfToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<Written<ApiDevice>> {
  return write(
    `${site(siteId)}/devices/${encodeURIComponent(deviceId)}`,
    'PATCH',
    csrfToken,
    { enabled },
    parseDevice,
    'Nie udało się zmienić urządzenia.',
    fetchFn,
  )
}

export type ConnectionFieldErrors = Partial<
  Record<'name' | 'host' | 'port' | 'unitId' | 'pollIntervalSeconds' | 'deviceName' | 'profile', string>
>

export interface ConnectionForm {
  name: string
  host: string
  port: string
  unitId: string
  pollIntervalSeconds: string
  deviceName: string
  profile: string
}

const PRIVATE_V4 = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})$/
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
const HOST = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*\.?$/

function intIn(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value.trim())) return null
  const n = Number(value.trim())
  return n >= min && n <= max ? n : null
}

/** Wstępna kontrola w przeglądarce (te same reguły co serwer, D44); ostatecznie decyduje serwer. */
export function validateConnection(
  form: ConnectionForm,
  profiles: readonly ApiProfile[],
): { errors: ConnectionFieldErrors; input: NewConnection | null } {
  const errors: ConnectionFieldErrors = {}
  const name = form.name.trim()
  const deviceName = form.deviceName.trim()
  const host = form.host.trim()
  if (!name) errors.name = 'Podaj nazwę połączenia, np. „Logger w garażu”.'
  if (!deviceName) errors.deviceName = 'Podaj nazwę urządzenia.'
  if (!host) errors.host = 'Podaj adres urządzenia w sieci lokalnej.'
  else if (IPV4.test(host) ? !PRIVATE_V4.test(host) : !HOST.test(host) || /\.\d+\.?$|^\d+$/.test(host))
    errors.host = 'Dozwolony prywatny adres IPv4 (10.x, 172.16–31.x, 192.168.x) albo nazwa hosta.'
  else if (/^localhost\.?$|\.localhost\.?$/i.test(host)) errors.host = 'Adres lokalny serwera jest niedozwolony.'
  const port = intIn(form.port, 1, 65535)
  if (port === null) errors.port = 'Port od 1 do 65535 (Modbus TCP zwykle 502).'
  const unitId = intIn(form.unitId, 0, 255)
  if (unitId === null) errors.unitId = 'Unit ID od 0 do 255.'
  let interval: number | null = null
  if (form.pollIntervalSeconds.trim()) {
    interval = intIn(form.pollIntervalSeconds, 1, 3600)
    if (interval === null) errors.pollIntervalSeconds = 'Interwał od 1 do 3600 s albo puste (z profilu).'
  }
  const profile = profiles.find((p) => `${p.id}@${p.version}` === form.profile)
  if (!profile) errors.profile = 'Wybierz profil urządzenia.'
  if (Object.keys(errors).length > 0 || !profile || port === null || unitId === null) return { errors, input: null }
  return {
    errors,
    input: {
      name,
      host,
      port,
      unitId,
      pollIntervalSeconds: interval,
      deviceName,
      profileId: profile.id,
      profileVersion: profile.version,
    },
  }
}
