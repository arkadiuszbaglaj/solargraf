/** Wykresy i historia instalacji wybranej w przełączniku (D66). */
export const CHARTS_PATH = '/wykresy'

/** Ustawienia → Stan serwera (D60). */
export const SERVER_HEALTH_PATH = '/ustawienia/serwer'

/** Ustawienia → Falownik: agent i połączenia z urządzeniami wybranej instalacji (D80). */
export const INVERTER_SETTINGS_PATH = '/ustawienia/falownik'

/** Adres zakładki „Falownik” z wybraną instalacją. */
export function inverterSettingsUrl(siteId: string): string {
  return `${INVERTER_SETTINGS_PATH}?${new URLSearchParams({ instalacja: siteId })}`
}

/** Ustawienia → Aktualizacje (D63, D65). */
export const UPDATES_PATH = '/ustawienia/aktualizacje'

/** Alarmy instalacji wybranej w przełączniku (D55). */
export const ALARMS_PATH = '/alarmy'

/** Raporty energii instalacji wybranej w przełączniku — OWNER/ADMIN (D74). */
export const REPORTS_PATH = '/raporty'

/** Zakładka „Urządzenia” instalacji wybranej w przełączniku. */
export const DEVICES_TAB_PATH = '/urzadzenia'

/** Adres zakładki „Urządzenia” z wybraną instalacją i opcjonalnie urządzeniem. */
export function devicesUrl(siteId: string, deviceId?: string): string {
  const params = new URLSearchParams({ instalacja: siteId })
  if (deviceId) params.set('urzadzenie', deviceId)
  return `${DEVICES_TAB_PATH}?${params}`
}
