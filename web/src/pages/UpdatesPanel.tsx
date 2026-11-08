import { useEffect, useState } from 'react'
import type { ChangeResult, UpdateJob, UpdatesState } from '../api/updates'
import { checkUpdates, getUpdates, installUpdate, setAutomaticCheck } from '../api/updates'
import { useOptionalSession } from '../auth/SessionContext'
import { Panel } from '../components/Panel'
import { WidgetState } from '../components/WidgetState'
import { usePeriodic } from '../hooks/usePeriodic'
import { formatDateTime } from '../lib/format'
import { CHECK_ERROR_TEXT, JOB_STATE_TEXT, JOB_STEP_TEXT } from '../lib/updates'
import styles from './ServerHealthPage.module.css'

/** Stan zmienia worker najwyżej raz na dobę — częste odświeżanie nic nie wnosi. */
export const UPDATES_REFRESH_MS = 5 * 60_000
/** W trakcie instalacji (D65) — postęp co kilka sekund. */
export const UPDATES_ACTIVE_REFRESH_MS = 5_000

/** Polecenie alternatywne dla instalacji z aplikacji (D65). */
const UPDATE_COMMAND = 'sudo solargraf update'

type Loaded = { kind: 'ok'; data: UpdatesState } | { kind: 'forbidden' }

/** Wynik zmiany pokazujemy do następnego odświeżenia danych, na których go wykonano. */
interface Override {
  base: Loaded
  data: UpdatesState
}

function AvailableVersion({ state, timeZone }: { state: UpdatesState; timeZone: string }) {
  const a = state.available
  if (a === null) {
    return (
      <p className={styles.updateLine}>
        {state.lastSuccessAt === null ? 'Brak informacji o nowszej wersji.' : 'Masz najnowszą wersję.'}
      </p>
    )
  }
  return (
    <div className={styles.updateBox}>
      <p className={styles.updateLine}>
        <strong>Dostępna wersja {a.version}</strong>{' '}
        <span className={styles.muted}>(wydana {formatDateTime(a.releasedAt, timeZone)})</span>
        {a.security ? <span className={styles.securityTag}>Poprawki bezpieczeństwa</span> : null}
        {state.dismissed ? <span className={styles.muted}> · komunikat ukryty</span> : null}
      </p>
      {a.notes ? <p className={styles.notes}>{a.notes}</p> : null}
      {a.directUpgrade ? null : (
        <p className={styles.WARNING}>
          Ta wersja wymaga wcześniejszej aktualizacji pośredniej — sprawdź informacje o wydaniu.
        </p>
      )}
      <p className={styles.muted}>
        <a href={a.infoUrl} target="_blank" rel="noopener noreferrer">
          Informacje o wydaniu
        </a>
      </p>
    </div>
  )
}

/** Odświeża stan co kilka sekund, dopóki aktualizacja trwa albo czeka na usługę serwera. */
function ActivePoller({ onTick }: { onTick: () => void }) {
  useEffect(() => {
    const id = setInterval(onTick, UPDATES_ACTIVE_REFRESH_MS)
    return () => clearInterval(id)
  }, [onTick])
  return null
}

function versionsText(job: UpdateJob): string {
  if (job.fromVersion !== null && job.toVersion !== null) return ` ${job.fromVersion} → ${job.toVersion}`
  return job.fromVersion === null ? '' : ` (z wersji ${job.fromVersion})`
}

function LastJob({ job, running, timeZone }: { job: UpdateJob; running: boolean; timeZone: string }) {
  if (running && job.state === 'RUNNING') {
    return (
      <p className={styles.updateLine} role="status">
        <strong>Aktualizacja w toku{versionsText(job)}</strong> — etap: {JOB_STEP_TEXT[job.step]}. Aplikacja może być
        przez chwilę niedostępna.
      </p>
    )
  }
  // RUNNING bez trwającej aktualizacji — przerwana (np. restart serwera); nie zgadujemy wyniku.
  const problem = job.state === 'FAILED' || job.state === 'ROLLED_BACK' || job.state === 'RUNNING'
  const when = formatDateTime(job.finishedAt ?? job.startedAt, timeZone)
  if (job.reason === 'LOW_DISK') {
    return (
      <p className={styles.WARNING}>
        Ostatnia aktualizacja{versionsText(job)}, {when}: nie rozpoczęła się — za mało miejsca na dysku serwera
        {job.freeMb !== null && job.requiredMb !== null
          ? ` (wolne ${job.freeMb} MB, wymagane ${job.requiredMb} MB)`
          : ''}
        . Cache budowania Dockera został już usunięty. Zwolnij miejsce na serwerze, np. usuń stare kopie zapasowe
        albo nieużywane obrazy (<code>sudo docker system df</code> pokaże, co zajmuje miejsce), i spróbuj ponownie.
      </p>
    )
  }
  const step = job.state === 'FAILED' ? ` (etap: ${JOB_STEP_TEXT[job.step]})` : ''
  return (
    <p className={problem ? styles.WARNING : styles.muted}>
      Ostatnia aktualizacja{versionsText(job)}, {when}: {JOB_STATE_TEXT[job.state]}
      {step}.
    </p>
  )
}

/** Instalacja dostępnej wersji (D65): zlecenie usłudze serwera, postęp i wynik ostatniej. */
function InstallSection({
  state,
  busy,
  canChange,
  watching,
  onInstall,
  timeZone,
}: {
  state: UpdatesState
  busy: boolean
  canChange: boolean
  watching: boolean
  onInstall: (version: string) => void
  timeZone: string
}) {
  const [confirming, setConfirming] = useState<string | null>(null)
  const { install, available } = state
  const active = install.running || install.requested
  const installable = available !== null && available.directUpgrade && install.supported && canChange && !active
  const justInstalled =
    watching && !active && install.last?.state === 'SUCCESS' && install.last.toVersion === state.currentVersion
  return (
    <section className={styles.installBox} aria-label="Instalacja aktualizacji">
      {install.requested && !install.running ? (
        <p className={styles.updateLine} role="status">
          <strong>Instalacja zlecona</strong> — czeka na uruchomienie na serwerze.
        </p>
      ) : null}
      {install.last ? <LastJob job={install.last} running={install.running} timeZone={timeZone} /> : null}
      {justInstalled ? (
        <div className={styles.updateActions}>
          <span>Zainstalowano wersję {state.currentVersion}.</span>
          <button type="button" className={styles.button} onClick={() => window.location.reload()}>
            Wczytaj nową wersję strony
          </button>
        </div>
      ) : null}
      {available !== null && installable ? (
        confirming === available.version ? (
          <div className={styles.confirmBox} role="group" aria-label="Potwierdzenie instalacji">
            <p>
              Zainstalować wersję {available.version}? Najpierw powstanie kopia zapasowa. Aplikacja będzie niedostępna
              przez kilka–kilkanaście minut; jeśli coś się nie uda, serwer sam wróci do wersji {state.currentVersion}.
            </p>
            <div className={styles.updateActions}>
              <button
                type="button"
                className={`${styles.button} ${styles.primary}`}
                disabled={busy}
                onClick={() => {
                  setConfirming(null)
                  onInstall(available.version)
                }}
              >
                Zainstaluj teraz
              </button>
              <button type="button" className={styles.button} disabled={busy} onClick={() => setConfirming(null)}>
                Anuluj
              </button>
            </div>
          </div>
        ) : (
          <div className={styles.updateActions}>
            <button
              type="button"
              className={`${styles.button} ${styles.primary}`}
              disabled={busy}
              onClick={() => setConfirming(available.version)}
            >
              Zainstaluj wersję {available.version}
            </button>
          </div>
        )
      ) : null}
      {available !== null && !install.supported ? (
        <p className={styles.muted}>
          Na tym serwerze instalacja z aplikacji jest niedostępna. Zainstaluj poleceniem: <code>{UPDATE_COMMAND}</code>
        </p>
      ) : (
        <p className={styles.muted}>
          Aktualizację można też zainstalować na serwerze poleceniem <code>{UPDATE_COMMAND}</code> — robi kopię zapasową i
          przy błędzie wraca do poprzedniej wersji.
        </p>
      )}
    </section>
  )
}

/** Ustawienia → Aktualizacje (D15, D63, D65). Dostęp sprawdza serwer — tylko OWNER. */
export function UpdatesPanel({
  fetchFn,
  onExpired,
  timeZone,
}: {
  fetchFn: typeof fetch
  onExpired: () => void
  timeZone: string
}) {
  const auth = useOptionalSession()
  const csrfToken = auth?.session.csrfToken ?? null
  const [override, setOverride] = useState<Override | null>(null)
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)
  // Instalacja zlecona w tej karcie — po sukcesie proponujemy wczytanie nowej wersji strony.
  const [watching, setWatching] = useState(false)

  const { state, reload } = usePeriodic<Loaded>(
    'updates',
    async (_now, signal) => {
      const result = await getUpdates(fetchFn, signal)
      if (result.kind === 'anonymous') {
        onExpired()
        throw new Error('expired')
      }
      if (result.kind === 'error') throw new Error('updates')
      return result
    },
    UPDATES_REFRESH_MS,
  )

  if (state.status === 'loading') return <WidgetState status={{ kind: 'loading' }} />
  if (state.status === 'error') return <WidgetState status={{ kind: 'error', onRetry: reload }} />
  if (state.data.kind === 'forbidden') {
    return (
      <WidgetState
        status={{ kind: 'empty', message: 'Aktualizacje są dostępne tylko dla właściciela organizacji (rola OWNER).' }}
      />
    )
  }
  const loaded = state.data
  const data = override?.base === loaded ? override.data : loaded.data
  const active = data.install.running || data.install.requested

  const run = async (action: (token: string) => Promise<ChangeResult>, done: (next: UpdatesState) => string) => {
    if (csrfToken === null) return
    setBusy(true)
    setMessage(null)
    const result = await action(csrfToken)
    setBusy(false)
    if (!result.ok) {
      setMessage({ error: true, text: result.message })
      return
    }
    setOverride({ base: loaded, data: result.data })
    setMessage({ error: false, text: done(result.data) })
  }

  const check = async () => {
    setChecking(true)
    await run(
      (token) => checkUpdates(token, fetchFn),
      (next) =>
        next.lastCheckedAt === data.lastCheckedAt
          ? 'Sprawdzono przed chwilą — kolejne sprawdzenie będzie możliwe za minutę.'
          : next.lastError === null
            ? 'Sprawdzono.'
            : 'Nie udało się sprawdzić aktualizacji.',
    )
    setChecking(false)
  }
  const toggle = () =>
    run(
      (token) => setAutomaticCheck(!data.automatic, token, fetchFn),
      (next) => (next.automatic ? 'Automatyczne sprawdzanie włączone.' : 'Automatyczne sprawdzanie wyłączone.'),
    )
  const install = (version: string) =>
    run(
      (token) => installUpdate(version, token, fetchFn),
      () => {
        setWatching(true)
        return 'Zlecono instalację. Postęp pojawi się powyżej.'
      },
    )

  const time = (iso: string | null, empty: string): string => (iso === null ? empty : formatDateTime(iso, timeZone))
  const failedNotice = active
    ? 'Serwer jest chwilowo niedostępny — to normalne w trakcie aktualizacji. Odświeżam co kilka sekund.'
    : 'Nie udało się odświeżyć — stan z poprzedniego pobrania.'

  return (
    <Panel title="Aktualizacje">
      <WidgetState status={{ kind: 'ready' }} staleNotice={state.failed ? failedNotice : null}>
        {active ? <ActivePoller onTick={reload} /> : null}
        <dl className={styles.list}>
          <div className={styles.row}>
            <dt>Zainstalowana wersja</dt>
            <dd>{data.currentVersion}</dd>
          </div>
          {data.configured ? (
            <>
              <div className={styles.row}>
                <dt>Ostatnie sprawdzenie</dt>
                <dd>{time(data.lastCheckedAt, 'jeszcze nie sprawdzano')}</dd>
              </div>
              {data.lastError === null ? null : (
                <div className={styles.row}>
                  <dt>Wynik</dt>
                  <dd className={styles.WARNING}>Nie udało się sprawdzić: {CHECK_ERROR_TEXT[data.lastError]}</dd>
                </div>
              )}
              <div className={styles.row}>
                <dt>Ostatnie udane sprawdzenie</dt>
                <dd>{time(data.lastSuccessAt, 'brak')}</dd>
              </div>
              <div className={styles.row}>
                <dt>Następne automatyczne</dt>
                <dd>{data.automatic ? time(data.nextCheckAt, 'wkrótce') : 'wyłączone'}</dd>
              </div>
            </>
          ) : null}
        </dl>

        {data.configured ? (
          <>
            <AvailableVersion state={data} timeZone={timeZone} />
            <InstallSection
              state={data}
              busy={busy}
              canChange={csrfToken !== null}
              watching={watching}
              onInstall={(version) => void install(version)}
              timeZone={timeZone}
            />
            {csrfToken === null ? null : (
              <div className={styles.updateActions}>
                <label className={styles.checkbox}>
                  <input type="checkbox" checked={data.automatic} disabled={busy} onChange={() => void toggle()} />
                  Sprawdzaj automatycznie raz w tygodniu
                </label>
                <button type="button" className={styles.button} disabled={busy} onClick={() => void check()}>
                  {checking ? 'Sprawdzanie…' : 'Sprawdź aktualizacje'}
                </button>
              </div>
            )}
            <p className={styles.muted}>
              Sprawdzenie pobiera tylko podpisaną informację o najnowszej wersji — bez danych instalacji.
            </p>
          </>
        ) : (
          <p className={styles.muted}>Ta wersja aplikacji nie ma skonfigurowanego sprawdzania aktualizacji.</p>
        )}
        <p role="status" aria-live="polite" className={message?.error ? styles.CRITICAL : styles.muted}>
          {message?.text ?? ''}
        </p>
      </WidgetState>
    </Panel>
  )
}
