import type { DeviceStatus, SupportLevel } from '../api/devices'

/** Etykiety statusu urządzenia z serwera (D38). Nigdy „offline” — brak agenta to stan nieznany. */
export const STATUS_LABEL: Record<DeviceStatus, string> = {
  OK: 'Działa',
  STALE: 'Dane nieaktualne',
  ERROR: 'Błąd odczytu',
  UNKNOWN: 'Stan nieznany',
  DISABLED: 'Wyłączone',
}

/** Poziom wsparcia profilu (D58): krótka etykieta i opis ryzyka. */
export const SUPPORT_LEVEL: Record<SupportLevel, { label: string; description: string }> = {
  VERIFIED: {
    label: 'Zweryfikowany sprzętowo',
    description: 'Profil przetestowany na rzeczywistym modelu i firmware.',
  },
  COMMUNITY: {
    label: 'Z dokumentacji, test na symulatorze',
    description:
      'Profil zbudowany z dokumentacji producenta i sprawdzony na symulatorze, bez testu na sprzęcie. Odczyty warto porównać z wyświetlaczem urządzenia.',
  },
  EXPERIMENTAL: {
    label: 'Eksperymentalny',
    description: 'Profil niepełny albo bez potwierdzonej dokumentacji. Nie polegaj na odczytach bez sprawdzenia.',
  },
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
