import type { DeviceStatus } from '../api/devices'

/** Etykiety statusu urządzenia z serwera (D38). Nigdy „offline” — brak agenta to stan nieznany. */
export const STATUS_LABEL: Record<DeviceStatus, string> = {
  OK: 'Działa',
  STALE: 'Dane nieaktualne',
  ERROR: 'Błąd odczytu',
  UNKNOWN: 'Stan nieznany',
  DISABLED: 'Wyłączone',
}

export const KIND_LABEL: Record<string, string> = {
  INVERTER: 'Falownik',
  METER: 'Licznik',
  BATTERY: 'Magazyn energii',
  BMS: 'BMS',
  MPPT: 'MPPT',
  SENSOR: 'Czujnik',
  GATEWAY: 'Bramka',
}
