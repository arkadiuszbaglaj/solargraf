import type { CheckError, JobState, JobStep } from '../api/updates'

/** Opis wyniku sprawdzenia — bez szczegółów technicznych (D63: błąd nie jest alarmem). */
export const CHECK_ERROR_TEXT: Record<CheckError, string> = {
  NOT_CONFIGURED: 'ta wersja aplikacji nie ma skonfigurowanego sprawdzania aktualizacji',
  NETWORK: 'brak połączenia z serwerem wydań',
  TOO_LARGE: 'nieprawidłowa odpowiedź serwera wydań',
  INVALID_MANIFEST: 'nieprawidłowa odpowiedź serwera wydań',
  INVALID_SIGNATURE: 'informacja o wersji ma nieprawidłowy podpis i została odrzucona',
}

/** Etap aktualizacji wykonywanej na serwerze (D65). */
export const JOB_STEP_TEXT: Record<JobStep, string> = {
  CHECK: 'sprawdzanie wersji',
  BACKUP: 'kopia zapasowa',
  BUILD: 'budowanie nowej wersji',
  START: 'migracje bazy i uruchamianie',
  ROLLBACK: 'przywracanie poprzedniej wersji',
  CLEANUP: 'sprzątanie',
  DONE: 'zakończono',
}

/** Wynik ostatniej aktualizacji; RUNNING bez trwającej aktualizacji oznacza przerwanie. */
export const JOB_STATE_TEXT: Record<JobState, string> = {
  RUNNING: 'przerwana — brak informacji o zakończeniu',
  SUCCESS: 'zakończona powodzeniem',
  FAILED: 'nie powiodła się',
  ROLLED_BACK: 'nie powiodła się — przywrócono poprzednią wersję',
  NO_UPDATE: 'brak nowszej wersji do zainstalowania',
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

/** Etapy pokazywane na liście postępu (kolejność skryptu aktualizacji, D65). */
export const JOB_STEPS_SHOWN: readonly { step: JobStep; label: string }[] = [
  { step: 'CHECK', label: 'Przygotowanie i sprawdzenie miejsca' },
  { step: 'BACKUP', label: 'Kopia zapasowa' },
  { step: 'BUILD', label: 'Pobieranie i budowanie nowej wersji' },
  { step: 'START', label: 'Migracje bazy i uruchamianie usług' },
  { step: 'CLEANUP', label: 'Sprzątanie' },
]

export type StepStatus = 'done' | 'active' | 'failed' | 'interrupted' | 'pending' | 'skipped'

export const STEP_STATUS_TEXT: Record<StepStatus, string> = {
  done: 'gotowe',
  active: 'w toku',
  failed: 'błąd',
  interrupted: 'przerwane',
  pending: 'oczekuje',
  skipped: 'pominięte',
}

/**
 * Stan każdego etapu z zapisu ostatniej aktualizacji. `null` — nie da się go uczciwie odtworzyć
 * (brak aktualizacji do zainstalowania, powrót do poprzedniej wersji, etap spoza listy) —
 * wtedy UI pokazuje sam opis wyniku zamiast zgadywać, który etap zawiódł.
 */
export function stepStatuses(
  job: { state: JobState; step: JobStep },
  running: boolean,
): { step: JobStep; label: string; status: StepStatus }[] | null {
  if (job.state === 'SUCCESS') return JOB_STEPS_SHOWN.map(({ step, label }) => ({ step, label, status: 'done' }))
  if (job.state === 'NO_UPDATE' || job.state === 'ROLLED_BACK') return null
  const current = JOB_STEPS_SHOWN.findIndex((s) => s.step === job.step)
  if (current < 0) return null
  const at: StepStatus = job.state === 'FAILED' ? 'failed' : running ? 'active' : 'interrupted'
  const after: StepStatus = job.state === 'RUNNING' && running ? 'pending' : 'skipped'
  return JOB_STEPS_SHOWN.map(({ step, label }, i) => ({
    step,
    label,
    status: i < current ? 'done' : i === current ? at : after,
  }))
}
