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
  /** Odświeżanie podglądu na żywo (D78); null — z profilu. */
  liveIntervalSeconds: number | null
  /** Limit czasu odczytu [s]; null — z profilu. Przenoszony bez zmian przy edycji połączenia. */
  timeoutSeconds: number | null
}

/** Metryka z profilu urządzenia (D47), widoczna dla każdej roli. */
export interface ApiDeviceMetric {
  key: string
  channel: number | null
  name: string
  unit: string
  cumulative: boolean
}

export type SupportLevel = 'VERIFIED' | 'COMMUNITY' | 'EXPERIMENTAL'

const SUPPORT_LEVELS: ReadonlySet<string> = new Set(['VERIFIED', 'COMMUNITY', 'EXPERIMENTAL'])

/** Znany poziom wsparcia albo null (brak, profil spoza katalogu albo nowa wartość serwera). */
export const parseSupportLevel = (v: unknown): SupportLevel | null =>
  typeof v === 'string' && SUPPORT_LEVELS.has(v) ? (v as SupportLevel) : null

export interface ApiDevice {
  id: string
  name: string
  kind: string
  manufacturer: string | null
  model: string | null
  enabled: boolean
  status: DeviceStatus
  lastSuccessAt: string | null
  /** Agent połączenia urządzenia (D52); null — połączenie bez agenta. */
  agentId: string | null
  /** Szczegóły techniczne — tylko OWNER/ADMIN (D38); `null` dla podglądu. */
  details: {
    firmwareVersion: string | null
    serialNumber: string | null
    profileId: string | null
    profileVersion: string | null
    connection: ApiConnection
  } | null
  metrics: ApiDeviceMetric[]
  /** Poziom wsparcia profilu (D58); null — nieznany. */
  supportLevel: SupportLevel | null
}

export interface ApiProfile {
  id: string
  version: string
  name: string
  manufacturer: string
  deviceKind: string
  simulated: boolean
  supportLevel: SupportLevel | null
  modbusTcp: boolean
  pollIntervalSeconds: number
  /** Domyślne odświeżanie podglądu na żywo (D78); null — podgląd w rytmie zapisu. */
  liveIntervalSeconds: number | null
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
/** Liczba albo null; brak pola (starszy serwer) to null. */
const numOrNull = (v: unknown): number | null | undefined =>
  v === null || v === undefined ? null : typeof v === 'number' && Number.isFinite(v) ? v : undefined

function parseConnection(v: unknown): ApiConnection | null {
  if (!isRecord(v) || typeof v.id !== 'string' || typeof v.name !== 'string') return null
  const host = strOrNull(v.host)
  const port = intOrNull(v.port)
  const unitId = intOrNull(v.unit_id)
  const interval = intOrNull(v.poll_interval_seconds)
  const live = numOrNull(v.live_interval_seconds)
  const timeout = v.timeout_seconds === undefined ? null : intOrNull(v.timeout_seconds)
  if (
    host === undefined ||
    port === undefined ||
    unitId === undefined ||
    interval === undefined ||
    live === undefined ||
    timeout === undefined
  )
    return null
  return {
    id: v.id,
    name: v.name,
    host,
    port,
    unitId,
    pollIntervalSeconds: interval,
    liveIntervalSeconds: live,
    timeoutSeconds: timeout,
  }
}

export function parseMetric(v: unknown): ApiDeviceMetric | null {
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
  // Starsze odpowiedzi bez pola `agent_id` — agent nieznany.
  const agentId = v.agent_id === undefined ? null : strOrNull(v.agent_id)
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof kind !== 'string' ||
    typeof enabled !== 'boolean' ||
    typeof status !== 'string' ||
    !STATUSES.has(status) ||
    manufacturer === undefined ||
    model === undefined ||
    lastSuccessAt === undefined ||
    agentId === undefined
  ) {
    return null
  }
  let details: ApiDevice['details'] = null
  if (v.details !== null) {
    if (!isRecord(v.details)) return null
    const firmwareVersion = strOrNull(v.details.firmware_version)
    const serialNumber = strOrNull(v.details.serial_number)
    const profileId = strOrNull(v.details.profile_id)
    const profileVersion = strOrNull(v.details.profile_version)
    const connection = parseConnection(v.details.connection)
    if (
      firmwareVersion === undefined ||
      serialNumber === undefined ||
      profileId === undefined ||
      profileVersion === undefined ||
      !connection
    ) {
      return null
    }
    details = { firmwareVersion, serialNumber, profileId, profileVersion, connection }
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
    agentId,
    details,
    metrics,
    supportLevel: parseSupportLevel(v.support_level),
  }
}

export function parseProfile(v: unknown): ApiProfile | null {
  if (!isRecord(v)) return null
  const { id, version, name, manufacturer, device_kind: kind, origin, support_level: level } = v
  const interval = v.poll_interval_seconds
  const live = numOrNull(v.live_interval_seconds)
  if (
    typeof id !== 'string' ||
    typeof version !== 'string' ||
    typeof name !== 'string' ||
    typeof manufacturer !== 'string' ||
    typeof kind !== 'string' ||
    (origin !== 'DEVICE' && origin !== 'SIMULATED') ||
    typeof level !== 'string' ||
    !Array.isArray(v.transports) ||
    !Number.isInteger(interval) ||
    live === undefined
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
    supportLevel: parseSupportLevel(level),
    modbusTcp: v.transports.includes('MODBUS_TCP'),
    pollIntervalSeconds: interval as number,
    liveIntervalSeconds: live,
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

/** GET z walidacją odpowiedzi; wspólne dla zasobów instalacji (urządzenia, alarmy). */
export async function load<T>(
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

export type AgentStatus = 'ONLINE' | 'UNREACHABLE' | 'DISABLED'

/** Agent obsługujący połączenia instalacji (D52); wersja tylko dla OWNER/ADMIN. */
export interface ApiAgent {
  id: string
  name: string
  status: AgentStatus
  lastHeartbeatAt: string | null
  version: string | null
}

const AGENT_STATUSES: ReadonlySet<string> = new Set(['ONLINE', 'UNREACHABLE', 'DISABLED'])

export function parseAgent(v: unknown): ApiAgent | null {
  if (!isRecord(v)) return null
  const { id, name, status } = v
  const lastHeartbeatAt = strOrNull(v.last_heartbeat_at)
  const version = strOrNull(v.version)
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof status !== 'string' ||
    !AGENT_STATUSES.has(status) ||
    lastHeartbeatAt === undefined ||
    version === undefined
  ) {
    return null
  }
  return { id, name, status: status as AgentStatus, lastHeartbeatAt, version }
}

export const listSiteAgents = (siteId: string, fetchFn: typeof fetch = fetch, signal?: AbortSignal) =>
  load(`${site(siteId)}/agents`, (v) => parseList(v, parseAgent), fetchFn, signal)

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
  liveIntervalSeconds: number | null
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
      live_interval_seconds: input.liveIntervalSeconds,
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
  Record<
    'name' | 'host' | 'port' | 'unitId' | 'pollIntervalSeconds' | 'liveIntervalSeconds' | 'deviceName' | 'profile',
    string
  >
>

export interface ConnectionForm {
  name: string
  host: string
  port: string
  unitId: string
  pollIntervalSeconds: string
  liveIntervalSeconds: string
  deviceName: string
  profile: string
}

const PRIVATE_V4 = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})$/
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
const HOST = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*\.?$/

/** Liczba z kropką albo przecinkiem (np. „1,5”) w zakresie albo null. */
function decimalIn(value: string, min: number, max: number): number | null {
  const text = value.trim().replace(',', '.')
  if (!/^\d+(\.\d+)?$/.test(text)) return null
  const n = Number(text)
  return n >= min && n <= max ? n : null
}

function intIn(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value.trim())) return null
  const n = Number(value.trim())
  return n >= min && n <= max ? n : null
}

export type TargetFieldErrors = Pick<ConnectionFieldErrors, 'host' | 'port' | 'unitId' | 'profile'>

/** Adres, port, Unit ID i profil — wspólne dla testu połączenia (D72) i dodania urządzenia. */
export function validateTarget(
  form: Pick<ConnectionForm, 'host' | 'port' | 'unitId' | 'profile'>,
  profiles: readonly ApiProfile[],
): { errors: TargetFieldErrors; target: TestTarget | null } {
  const { errors, address } = validateAddress(form)
  const profile = profiles.find((p) => `${p.id}@${p.version}` === form.profile)
  if (!profile) errors.profile = 'Wybierz profil urządzenia.'
  if (Object.keys(errors).length > 0 || !profile || !address) return { errors, target: null }
  return { errors, target: { ...address, profileId: profile.id, profileVersion: profile.version } }
}

/** Interwał zapisu i odświeżanie na żywo (D44, D78); `profilePoll` — interwał z profilu, gdy pole puste. */
function validateIntervals(
  form: Pick<ConnectionForm, 'pollIntervalSeconds' | 'liveIntervalSeconds'>,
  profilePoll: number | null,
): {
  errors: Pick<ConnectionFieldErrors, 'pollIntervalSeconds' | 'liveIntervalSeconds'>
  interval: number | null
  live: number | null
} {
  const errors: Pick<ConnectionFieldErrors, 'pollIntervalSeconds' | 'liveIntervalSeconds'> = {}
  let interval: number | null = null
  if (form.pollIntervalSeconds.trim()) {
    interval = intIn(form.pollIntervalSeconds, 1, 3600)
    if (interval === null) errors.pollIntervalSeconds = 'Interwał od 1 do 3600 s albo puste (z profilu).'
  }
  let live: number | null = null
  if (form.liveIntervalSeconds.trim()) {
    live = decimalIn(form.liveIntervalSeconds, 1, 3600)
    const saved = interval ?? profilePoll
    if (live === null) errors.liveIntervalSeconds = 'Odświeżanie od 1 do 3600 s (np. 1,5) albo puste (z profilu).'
    else if (saved !== null && live > saved)
      errors.liveIntervalSeconds = 'Odświeżanie na żywo nie może być rzadsze niż interwał odczytu.'
  }
  return { errors, interval, live }
}

/** Ustawienia istniejącego połączenia (PATCH, D44) — profil urządzeń się nie zmienia. */
export interface ConnectionSettingsInput {
  name: string
  host: string
  port: number
  unitId: number
  pollIntervalSeconds: number | null
  liveIntervalSeconds: number | null
  timeoutSeconds: number | null
}

export type ConnectionSettingsForm = Pick<
  ConnectionForm,
  'name' | 'host' | 'port' | 'unitId' | 'pollIntervalSeconds' | 'liveIntervalSeconds'
>

/** Wstępna kontrola edycji połączenia; limit czasu przenoszony bez zmian. Ostatecznie decyduje serwer. */
export function validateConnectionSettings(
  form: ConnectionSettingsForm,
  profilePoll: number | null,
  timeoutSeconds: number | null,
): { errors: ConnectionFieldErrors; input: ConnectionSettingsInput | null } {
  const { errors: addressErrors, address } = validateAddress(form)
  const { errors: intervalErrors, interval, live } = validateIntervals(form, profilePoll)
  const errors: ConnectionFieldErrors = { ...addressErrors, ...intervalErrors }
  const name = form.name.trim()
  if (!name) errors.name = 'Podaj nazwę połączenia, np. „Logger w garażu”.'
  if (Object.keys(errors).length > 0 || !address) return { errors, input: null }
  return {
    errors,
    input: { ...address, name, pollIntervalSeconds: interval, liveIntervalSeconds: live, timeoutSeconds },
  }
}

export function updateConnection(
  siteId: string,
  connectionId: string,
  input: ConnectionSettingsInput,
  csrfToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<Written<ApiConnection>> {
  return write(
    `${site(siteId)}/connections/${encodeURIComponent(connectionId)}`,
    'PATCH',
    csrfToken,
    {
      name: input.name,
      host: input.host,
      port: input.port,
      unit_id: input.unitId,
      poll_interval_seconds: input.pollIntervalSeconds,
      live_interval_seconds: input.liveIntervalSeconds,
      timeout_seconds: input.timeoutSeconds,
    },
    parseConnection,
    'Nie udało się zapisać połączenia.',
    fetchFn,
  )
}

/** Adres, port i Unit ID — prywatny adres w LAN (D44); bez profilu. */
function validateAddress(form: Pick<ConnectionForm, 'host' | 'port' | 'unitId'>): {
  errors: TargetFieldErrors
  address: { host: string; port: number; unitId: number } | null
} {
  const errors: TargetFieldErrors = {}
  const host = form.host.trim()
  if (!host) errors.host = 'Podaj adres urządzenia w sieci lokalnej.'
  else if (IPV4.test(host) ? !PRIVATE_V4.test(host) : !HOST.test(host) || /\.\d+\.?$|^\d+$/.test(host))
    errors.host = 'Dozwolony prywatny adres IPv4 (10.x, 172.16–31.x, 192.168.x) albo nazwa hosta.'
  else if (/^localhost\.?$|\.localhost\.?$/i.test(host)) errors.host = 'Adres lokalny serwera jest niedozwolony.'
  const port = intIn(form.port, 1, 65535)
  if (port === null) errors.port = 'Port od 1 do 65535 (Modbus TCP zwykle 502).'
  const unitId = intIn(form.unitId, 0, 255)
  if (unitId === null) errors.unitId = 'Unit ID od 0 do 255.'
  if (Object.keys(errors).length > 0 || port === null || unitId === null) return { errors, address: null }
  return { errors, address: { host, port, unitId } }
}

/** Wstępna kontrola w przeglądarce (te same reguły co serwer, D44); ostatecznie decyduje serwer. */
export function validateConnection(
  form: ConnectionForm,
  profiles: readonly ApiProfile[],
): { errors: ConnectionFieldErrors; input: NewConnection | null } {
  const { errors: targetErrors, target } = validateTarget(form, profiles)
  const errors: ConnectionFieldErrors = { ...targetErrors }
  const name = form.name.trim()
  const deviceName = form.deviceName.trim()
  if (!name) errors.name = 'Podaj nazwę połączenia, np. „Logger w garażu”.'
  if (!deviceName) errors.deviceName = 'Podaj nazwę urządzenia.'
  const profile = profiles.find((p) => `${p.id}@${p.version}` === form.profile)
  const { errors: intervalErrors, interval, live } = validateIntervals(form, profile?.pollIntervalSeconds ?? null)
  Object.assign(errors, intervalErrors)
  if (Object.keys(errors).length > 0 || !target) return { errors, input: null }
  return { errors, input: { ...target, name, pollIntervalSeconds: interval, liveIntervalSeconds: live, deviceName } }
}

// --- test połączenia (D72) ---

export interface TestTarget {
  host: string
  port: number
  unitId: number
  profileId: string
  profileVersion: string
}

export type TestState = 'PENDING' | 'RUNNING' | 'DONE' | 'EXPIRED'
export type TestResult = 'OK' | 'PARTIAL' | 'FAILED'
export type TestErrorCode =
  | 'TIMEOUT'
  | 'CONNECTION_REFUSED'
  | 'CONNECTION_LOST'
  | 'MODBUS_EXCEPTION'
  | 'INVALID_RESPONSE'
  | 'UNKNOWN_PROFILE'
  | 'TARGET_IN_USE'

export interface TestReading {
  metric: string
  channel: number | null
  name: string
  unit: string
  /** `null` — brak odczytu (nie zero). */
  value: number | null
  quality: 'GOOD' | 'INVALID' | 'MISSING'
}

export interface ConnectionTest {
  id: string
  state: TestState
  result: TestResult | null
  errorCode: TestErrorCode | null
  origin: 'DEVICE' | 'SIMULATED' | null
  readings: TestReading[]
}

const TEST_STATES: ReadonlySet<string> = new Set(['PENDING', 'RUNNING', 'DONE', 'EXPIRED'])
const TEST_RESULTS: ReadonlySet<string> = new Set(['OK', 'PARTIAL', 'FAILED'])
const TEST_ERRORS: ReadonlySet<string> = new Set([
  'TIMEOUT',
  'CONNECTION_REFUSED',
  'CONNECTION_LOST',
  'MODBUS_EXCEPTION',
  'INVALID_RESPONSE',
  'UNKNOWN_PROFILE',
  'TARGET_IN_USE',
])
const QUALITIES: ReadonlySet<string> = new Set(['GOOD', 'INVALID', 'MISSING'])

const oneOf = <T extends string>(set: ReadonlySet<string>, v: unknown): T | null | undefined =>
  v === null ? null : typeof v === 'string' && set.has(v) ? (v as T) : undefined

function parseTestReading(v: unknown): TestReading | null {
  if (!isRecord(v) || typeof v.metric !== 'string' || typeof v.name !== 'string' || typeof v.unit !== 'string')
    return null
  const channel = intOrNull(v.channel ?? null)
  const value = v.value === null ? null : typeof v.value === 'number' && Number.isFinite(v.value) ? v.value : undefined
  const quality = oneOf<TestReading['quality']>(QUALITIES, v.quality)
  if (channel === undefined || value === undefined || !quality) return null
  return { metric: v.metric, channel, name: v.name, unit: v.unit, value, quality }
}

export function parseConnectionTest(v: unknown): ConnectionTest | null {
  if (!isRecord(v) || typeof v.id !== 'string') return null
  const state = oneOf<TestState>(TEST_STATES, v.state)
  const result = oneOf<TestResult>(TEST_RESULTS, v.result ?? null)
  const errorCode = oneOf<TestErrorCode>(TEST_ERRORS, v.error_code ?? null)
  const origin = oneOf<'DEVICE' | 'SIMULATED'>(new Set(['DEVICE', 'SIMULATED']), v.origin ?? null)
  const readings = parseList(v.readings ?? [], parseTestReading)
  if (!state || result === undefined || errorCode === undefined || origin === undefined || readings === null)
    return null
  return { id: v.id, state, result, errorCode, origin, readings }
}

export function requestConnectionTest(
  siteId: string,
  target: TestTarget,
  csrfToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<Written<ConnectionTest>> {
  return write(
    `${site(siteId)}/connection-tests`,
    'POST',
    csrfToken,
    {
      host: target.host,
      port: target.port,
      unit_id: target.unitId,
      profile_id: target.profileId,
      profile_version: target.profileVersion,
    },
    parseConnectionTest,
    'Nie udało się zlecić testu połączenia.',
    fetchFn,
  )
}

export const getConnectionTest = (
  siteId: string,
  testId: string,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
) => load(`${site(siteId)}/connection-tests/${encodeURIComponent(testId)}`, parseConnectionTest, fetchFn, signal)
