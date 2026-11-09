import type { CheckError, JobState, JobStep, UpdateJob } from '../api/updates'

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
  DOWNLOAD: 'pobieranie nowej wersji',
  DISK: 'sprawdzanie wolnego miejsca',
  BACKUP: 'kopia zapasowa',
  BUILD: 'budowanie nowej wersji',
  START: 'migracje bazy i uruchamianie',
  VERIFY: 'sprawdzanie działania aplikacji',
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

/** Nazwa etapu na liście przebiegu aktualizacji. */
export const JOB_STEP_LABEL: Record<JobStep, string> = {
  CHECK: 'Przygotowanie i sprawdzenie wersji',
  DOWNLOAD: 'Pobieranie nowej wersji',
  DISK: 'Sprawdzenie wolnego miejsca',
  BACKUP: 'Kopia zapasowa',
  BUILD: 'Budowanie nowej wersji',
  START: 'Migracje bazy i uruchamianie usług',
  VERIFY: 'Sprawdzenie działania aplikacji',
  ROLLBACK: 'Przywracanie poprzedniej wersji',
  CLEANUP: 'Sprzątanie',
  DONE: 'Zakończenie',
}

/** Kolejność etapów skryptu (D65) — do pokazania etapów, które jeszcze czekają. */
const STEP_ORDER: readonly JobStep[] = ['CHECK', 'DOWNLOAD', 'DISK', 'BACKUP', 'BUILD', 'START', 'VERIFY', 'CLEANUP']

export type StepStatus = 'done' | 'active' | 'failed' | 'interrupted' | 'pending'

export const STEP_STATUS_TEXT: Record<StepStatus, string> = {
  done: 'gotowe',
  active: 'w toku',
  failed: 'błąd',
  interrupted: 'przerwane',
  pending: 'oczekuje',
}

export interface StepRow {
  step: JobStep
  label: string
  status: StepStatus
  startedAt: string | null
  finishedAt: string | null
  /** Czas trwania; dla etapu w toku — do `now`; `null` — etap nie rozpoczęty albo przerwany. */
  seconds: number | null
}

const secondsBetween = (from: string, to: number): number => Math.max(0, (to - Date.parse(from)) / 1000)

/**
 * Wiersze przebiegu aktualizacji wyłącznie z etapów zapisanych przez skrypt (czasy i wynik).
 * `null` — skrypt sprzed zapisu etapów: przebiegu nie odtwarzamy z samego bieżącego etapu.
 * W trakcie aktualizacji (bez powrotu do poprzedniej wersji) dochodzą etapy, które czekają.
 */
export function stepRows(job: Pick<UpdateJob, 'state' | 'steps'>, running: boolean, now: Date): StepRow[] | null {
  if (job.steps === null) return null
  const live = running && job.state === 'RUNNING'
  const rows: StepRow[] = job.steps.map((s) => {
    const status: StepStatus =
      s.result === 'OK' ? 'done' : s.result === 'FAILED' ? 'failed' : live ? 'active' : 'interrupted'
    const end = s.finishedAt !== null ? Date.parse(s.finishedAt) : status === 'active' ? now.getTime() : null
    return {
      step: s.step,
      label: JOB_STEP_LABEL[s.step],
      status,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      seconds: end === null ? null : secondsBetween(s.startedAt, end),
    }
  })
  if (live && !job.steps.some((s) => s.step === 'ROLLBACK')) {
    const last = job.steps.at(-1)
    const next = last === undefined ? 0 : STEP_ORDER.indexOf(last.step) + 1
    for (const step of STEP_ORDER.slice(next)) {
      rows.push({ step, label: JOB_STEP_LABEL[step], status: 'pending', startedAt: null, finishedAt: null, seconds: null })
    }
  }
  return rows
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Czas trwania etapu, np. „< 1 s”, „42 s”, „3 min 05 s”, „1 h 02 min”. */
export function formatDuration(seconds: number): string {
  const total = Math.floor(seconds)
  if (total < 1) return '< 1 s'
  if (total < 60) return `${total} s`
  if (total < 3600) return `${Math.floor(total / 60)} min ${pad(total % 60)} s`
  return `${Math.floor(total / 3600)} h ${pad(Math.floor((total % 3600) / 60))} min`
}
