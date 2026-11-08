import type { CheckError } from '../api/updates'

/** Opis wyniku sprawdzenia — bez szczegółów technicznych (D63: błąd nie jest alarmem). */
export const CHECK_ERROR_TEXT: Record<CheckError, string> = {
  NOT_CONFIGURED: 'ta wersja aplikacji nie ma skonfigurowanego sprawdzania aktualizacji',
  NETWORK: 'brak połączenia z serwerem wydań',
  TOO_LARGE: 'nieprawidłowa odpowiedź serwera wydań',
  INVALID_MANIFEST: 'nieprawidłowa odpowiedź serwera wydań',
  INVALID_SIGNATURE: 'informacja o wersji ma nieprawidłowy podpis i została odrzucona',
}

const POSTPONE_KEY = 'solargraf.updateBanner.postponed'

/**
 * Odłożenie komunikatu o wersji z poprawkami bezpieczeństwa — tylko do końca sesji karty
 * przeglądarki albo wylogowania (sessionStorage). Brak dostępu do pamięci: komunikat zostaje.
 */
export function isPostponed(version: string): boolean {
  try {
    return sessionStorage.getItem(POSTPONE_KEY) === version
  } catch {
    return false
  }
}

export function postpone(version: string): void {
  try {
    sessionStorage.setItem(POSTPONE_KEY, version)
  } catch {
    // Bez pamięci sesji komunikat pojawi się ponownie po odświeżeniu — to bezpieczny kierunek.
  }
}

export function clearPostponed(): void {
  try {
    sessionStorage.removeItem(POSTPONE_KEY)
  } catch {
    // jak wyżej
  }
}
