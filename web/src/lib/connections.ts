import type { ApiConnection, ApiDevice } from '../api/devices'

export interface ConnectionGroup {
  connection: ApiConnection
  /** Profil urządzeń połączenia (pierwsze z profilem) — do testu komunikacji i domyślnych interwałów. */
  profile: { id: string; version: string } | null
  devices: ApiDevice[]
}

/**
 * Urządzenia pogrupowane po połączeniu (logger/falownik pod jednym adresem), w kolejności pierwszego
 * wystąpienia. Urządzenia bez szczegółów (podgląd, D38) są pomijane — ich połączenia nie znamy.
 */
export function groupByConnection(devices: readonly ApiDevice[]): ConnectionGroup[] {
  const groups = new Map<string, ConnectionGroup>()
  for (const device of devices) {
    if (!device.details) continue
    const { connection, profileId, profileVersion } = device.details
    let group = groups.get(connection.id)
    if (!group) {
      group = { connection, profile: null, devices: [] }
      groups.set(connection.id, group)
    }
    if (!group.profile && profileId && profileVersion) group.profile = { id: profileId, version: profileVersion }
    group.devices.push(device)
  }
  return [...groups.values()]
}
