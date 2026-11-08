/** Wykresy i historia instalacji wybranej w przełączniku (D66). */
export const CHARTS_PATH = '/wykresy'

/** Ustawienia → Stan serwera (D60). */
export const SERVER_HEALTH_PATH = '/ustawienia/serwer'

/** Ustawienia → Aktualizacje (D63, D65). */
export const UPDATES_PATH = '/ustawienia/aktualizacje'

/** Zakładka „Urządzenia” instalacji wybranej w przełączniku. */
export const DEVICES_TAB_PATH = '/urzadzenia'

/** Adres zakładki „Urządzenia” z wybraną instalacją i opcjonalnie urządzeniem. */
export function devicesUrl(siteId: string, deviceId?: string): string {
  const params = new URLSearchParams({ instalacja: siteId })
  if (deviceId) params.set('urzadzenie', deviceId)
  return `${DEVICES_TAB_PATH}?${params}`
}
