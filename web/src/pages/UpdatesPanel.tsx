import {
  Circle,
  CircleAlert,
  CircleArrowUp,
  CircleCheck,
  CircleX,
  Info,
  LoaderCircle,
  RefreshCw,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import type { ChangeResult, UpdateJob, UpdatesState } from '../api/updates'
import { checkUpdates, getUpdates, installUpdate, setAutomaticCheck } from '../api/updates'
import { useOptionalSession } from '../auth/SessionContext'
import { WidgetState } from '../components/WidgetState'
import { useNow } from '../hooks/useNow'
import { usePeriodic } from '../hooks/usePeriodic'
import { formatAge, formatClock, formatDateTime } from '../lib/format'
import {
  CHECK_ERROR_TEXT,
  formatDuration,
  JOB_STEP_TEXT,
  STEP_STATUS_TEXT,
  type StepRow,
  type StepStatus,
  stepRows,
} from '../lib/updates'
import styles from './UpdatesPanel.module.css'

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

type Tone = 'ok' | 'accent' | 'warning' | 'danger' | 'muted'

function StatusLine({ icon: Icon, tone, children }: { icon: LucideIcon; tone: Tone; children: React.ReactNode }) {
  return (
    <p className={`${styles.statusLine} ${styles[tone]}`}>
      <Icon size={18} aria-hidden="true" className={styles.icon} />
      <span>{children}</span>
    </p>
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

export function versionsText(job: UpdateJob): string {
  if (job.fromVersion !== null && job.toVersion !== null) return ` ${job.fromVersion} → ${job.toVersion}`
  return job.fromVersion === null ? '' : ` (z wersji ${job.fromVersion})`
}

/** „3 godz. temu” z dokładną datą w podpowiedzi; brak czasu — tekst zastępczy. */
function Ago({ iso, now, timeZone, empty }: { iso: string | null; now: Date; timeZone: string; empty: string }) {
  if (iso === null) return <>{empty}</>
  const age = Math.max(0, (now.getTime() - Date.parse(iso)) / 1000)
  return (
    <time dateTime={iso} title={formatDateTime(iso, timeZone)}>
      {formatAge(age)} temu
    </time>
  )
}

/** Dostępna wersja: opis, znaczniki, odnośnik i instalacja (D63, D65). */
function AvailableVersion({
  state,
  busy,
  canChange,
  onInstall,
  timeZone,
}: {
  state: UpdatesState
  busy: boolean
  canChange: boolean
  onInstall: (version: string) => void
  timeZone: string
}) {
  const [confirming, setConfirming] = useState<string | null>(null)
  const a = state.available
  if (a === null) return null
  const { install } = state
  const active = install.running || install.requested
  const installable = a.directUpgrade && install.supported && canChange && !active
  return (
    <div className={styles.available}>
      <p className={styles.availableMeta}>
        Wydana {formatDateTime(a.releasedAt, timeZone)}
        {a.security ? <span className={styles.securityTag}>Poprawki bezpieczeństwa</span> : null}
        {state.dismissed ? <span> · komunikat ukryty</span> : null}
      </p>
      {a.notes ? <p className={styles.notes}>{a.notes}</p> : null}
      {a.directUpgrade ? null : (
        <StatusLine icon={CircleAlert} tone="warning">
          Ta wersja wymaga wcześniejszej aktualizacji pośredniej — sprawdź informacje o wydaniu.
        </StatusLine>
      )}
      <a href={a.infoUrl} target="_blank" rel="noopener noreferrer" className={styles.link}>
        Informacje o wydaniu
      </a>
      {install.requested && !install.running ? (
        <p role="status" className={styles.muted}>
          <strong className={styles.strong}>Instalacja zlecona</strong> — czeka na uruchomienie na serwerze.
        </p>
      ) : null}
      {installable ? (
        confirming === a.version ? (
          <div className={styles.confirmBox} role="group" aria-label="Potwierdzenie instalacji">
            <p>
              Zainstalować wersję {a.version}? Najpierw powstanie kopia zapasowa. Aplikacja będzie niedostępna przez
              kilka–kilkanaście minut; jeśli coś się nie uda, serwer sam wróci do wersji {state.currentVersion}.
            </p>
            <div className={styles.actions}>
              <button
                type="button"
                className={`${styles.button} ${styles.primary}`}
                disabled={busy}
                onClick={() => {
                  setConfirming(null)
                  onInstall(a.version)
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
          <div className={styles.actions}>
            <button
              type="button"
              className={`${styles.button} ${styles.primary}`}
              disabled={busy}
              onClick={() => setConfirming(a.version)}
            >
              Zainstaluj wersję {a.version}
            </button>
          </div>
        )
      ) : null}
    </div>
  )
}

const STEP_ICON: Record<StepStatus, { icon: LucideIcon; tone: Tone }> = {
  done: { icon: CircleCheck, tone: 'ok' },
  active: { icon: LoaderCircle, tone: 'accent' },
  failed: { icon: CircleX, tone: 'danger' },
  interrupted: { icon: CircleAlert, tone: 'warning' },
  pending: { icon: Circle, tone: 'muted' },
}

/** Lista etapów z rzeczywistymi czasami; etap w toku liczy czas na żywo. */
function StepList({ rows }: { rows: StepRow[] }) {
  return (
    <ol className={styles.steps} aria-label="Etapy aktualizacji">
      {rows.map((s) => {
        const { icon: Icon, tone } = STEP_ICON[s.status]
        return (
          <li key={s.step} className={`${styles.step} ${s.status === 'pending' ? styles.stepPending : ''}`}>
            <Icon
              size={18}
              aria-hidden="true"
              className={`${styles.icon} ${styles[tone]} ${s.status === 'active' ? styles.spin : ''}`}
            />
            <span className={styles.stepLabel}>{s.label}</span>
            {s.seconds !== null ? <span className={styles.stepTime}>{formatDuration(s.seconds)}</span> : null}
            <span className={`${styles.stepStatus} ${s.status === 'failed' ? styles.danger : ''}`}>
              {STEP_STATUS_TEXT[s.status]}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** Szczegóły przebiegu: godziny rozpoczęcia i zakończenia każdego etapu (strefa instalacji). */
function StepDetails({ rows, job, timeZone }: { rows: StepRow[]; job: UpdateJob; timeZone: string }) {
  const started = rows.filter((r) => r.startedAt !== null)
  if (started.length === 0) return null
  const total =
    job.finishedAt !== null ? Math.max(0, (Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000) : null
  return (
    <details className={styles.details}>
      <summary className={styles.summary}>Szczegóły</summary>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Etap</th>
              <th scope="col">Początek</th>
              <th scope="col">Koniec</th>
              <th scope="col">Czas</th>
              <th scope="col">Wynik</th>
            </tr>
          </thead>
          <tbody>
            {started.map((r) => (
              <tr key={r.step}>
                <th scope="row">{r.label}</th>
                <td>{r.startedAt !== null ? formatClock(r.startedAt, timeZone) : '—'}</td>
                <td>{r.finishedAt !== null ? formatClock(r.finishedAt, timeZone) : '—'}</td>
                <td>{r.seconds !== null ? formatDuration(r.seconds) : '—'}</td>
                <td>{STEP_STATUS_TEXT[r.status]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total !== null ? <p className={styles.muted}>Łączny czas: {formatDuration(total)}.</p> : null}
    </details>
  )
}

/** Ostatnia aktualizacja zapisana przez skrypt serwera (D65): wynik, wersje, czas i etapy. */
function LastJob({
  job,
  running,
  justInstalled,
  currentVersion,
  timeZone,
}: {
  job: UpdateJob
  running: boolean
  justInstalled: boolean
  currentVersion: string
  timeZone: string
}) {
  const inProgress = running && job.state === 'RUNNING'
  const lowDisk = job.reason === 'LOW_DISK'
  const head: { icon: LucideIcon; tone: Tone; title: string } = inProgress
    ? { icon: LoaderCircle, tone: 'accent', title: `Aktualizacja w toku${versionsText(job)}` }
    : lowDisk
      ? { icon: CircleAlert, tone: 'warning', title: 'Aktualizacja nie rozpoczęła się' }
      : job.state === 'SUCCESS'
        ? { icon: CircleCheck, tone: 'ok', title: 'Zaktualizowano' }
        : job.state === 'NO_UPDATE'
          ? { icon: Info, tone: 'muted', title: 'Brak nowszej wersji do zainstalowania' }
          : job.state === 'ROLLED_BACK'
            ? { icon: CircleAlert, tone: 'warning', title: 'Nie powiodła się — przywrócono poprzednią wersję' }
            : job.state === 'FAILED'
              ? { icon: CircleX, tone: 'danger', title: 'Aktualizacja nie powiodła się' }
              : // RUNNING bez trwającej aktualizacji — przerwana (np. restart serwera); nie zgadujemy wyniku.
                { icon: CircleAlert, tone: 'warning', title: 'Przerwana — brak informacji o zakończeniu' }
  // Etap w toku liczy czas co sekundę; poza aktualizacją wystarczy rzadkie odświeżenie.
  const now = useNow(inProgress ? 1000 : 60_000)
  const steps = stepRows(job, running, now)
  const versions =
    job.fromVersion !== null && job.toVersion !== null
      ? `z wersji ${job.fromVersion} do ${job.toVersion}`
      : job.fromVersion !== null
        ? `z wersji ${job.fromVersion}`
        : null
  const HeadIcon = head.icon
  return (
    <section className={styles.card} aria-label="Ostatnia aktualizacja">
      <div className={styles.jobHead}>
        <HeadIcon size={24} aria-hidden="true" className={`${styles.icon} ${styles[head.tone]}`} />
        <div>
          <h3 className={`${styles.jobTitle} ${styles[head.tone]}`} role={inProgress ? 'status' : undefined}>
            {head.title}
          </h3>
          {versions && !inProgress ? <p className={styles.jobVersions}>{versions}</p> : null}
          <p className={styles.muted}>
            Rozpoczęto: {formatDateTime(job.startedAt, timeZone)}
            {job.finishedAt ? ` · zakończono: ${formatDateTime(job.finishedAt, timeZone)}` : ''}
          </p>
        </div>
      </div>
      {inProgress ? (
        <p className={styles.muted}>
          Etap: {JOB_STEP_TEXT[job.step]}. Aplikacja może być przez chwilę niedostępna.
        </p>
      ) : null}
      {lowDisk ? (
        <p className={styles.warning}>
          Za mało miejsca na dysku serwera
          {job.freeMb !== null && job.requiredMb !== null
            ? ` (wolne ${job.freeMb} MB, wymagane ${job.requiredMb} MB)`
            : ''}
          . Cache budowania Dockera został już usunięty. Zwolnij miejsce na serwerze, np. usuń stare kopie zapasowe
          albo nieużywane obrazy (<code>sudo docker system df</code> pokaże, co zajmuje miejsce), i spróbuj ponownie.
        </p>
      ) : null}
      {steps !== null && steps.length > 0 ? (
        <>
          <StepList rows={steps} />
          <StepDetails rows={steps} job={job} timeZone={timeZone} />
        </>
      ) : steps === null && job.state !== 'NO_UPDATE' && !lowDisk ? (
        <p className={styles.muted}>
          Tę aktualizację wykonała starsza wersja skryptu, która nie zapisywała przebiegu etapów. Etapy z czasami
          będą widoczne od następnej aktualizacji.
        </p>
      ) : null}
      {job.state === 'SUCCESS' && job.reclaimedMb !== null ? (
        <p className={styles.muted}>Sprzątanie odzyskało {job.reclaimedMb} MB.</p>
      ) : null}
      {justInstalled ? (
        <div className={styles.actions}>
          <span>Zainstalowano wersję {currentVersion}.</span>
          <button type="button" className={styles.button} onClick={() => window.location.reload()}>
            Wczytaj nową wersję strony
          </button>
        </div>
      ) : null}
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
  const now = useNow(60_000)
  const uid = useId()
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
  const { install } = data
  const active = install.running || install.requested
  const justInstalled =
    watching && !active && install.last?.state === 'SUCCESS' && install.last.toVersion === data.currentVersion

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
  const installVersion = (version: string) =>
    run(
      (token) => installUpdate(version, token, fetchFn),
      () => {
        setWatching(true)
        return 'Zlecono instalację. Postęp pojawi się poniżej.'
      },
    )

  const failedNotice = active
    ? 'Serwer jest chwilowo niedostępny — to normalne w trakcie aktualizacji. Odświeżam co kilka sekund.'
    : 'Nie udało się odświeżyć — stan z poprzedniego pobrania.'

  return (
    <div className={styles.stack}>
      {active ? <ActivePoller onTick={reload} /> : null}
      {state.failed ? (
        <p className={styles.warning} role="status">
          {failedNotice}
        </p>
      ) : null}

      <section className={styles.card} aria-label="Wersja">
        <div>
          <p className={styles.label}>Zainstalowana wersja</p>
          <p className={styles.version}>{data.currentVersion}</p>
        </div>
        <hr className={styles.divider} />
        {data.configured ? (
          <>
            {data.lastError !== null ? (
              <StatusLine icon={CircleAlert} tone="warning">
                Nie udało się sprawdzić: {CHECK_ERROR_TEXT[data.lastError]}
              </StatusLine>
            ) : null}
            {data.available !== null ? (
              <StatusLine icon={CircleArrowUp} tone="accent">
                <strong>Dostępna wersja {data.available.version}</strong>
              </StatusLine>
            ) : data.lastSuccessAt === null ? (
              <StatusLine icon={Info} tone="muted">
                Brak informacji o nowszej wersji.
              </StatusLine>
            ) : data.lastError === null ? (
              <StatusLine icon={CircleCheck} tone="ok">
                Masz najnowszą wersję.
              </StatusLine>
            ) : null}
            <p className={styles.muted}>
              Sprawdzono: <Ago iso={data.lastCheckedAt} now={now} timeZone={timeZone} empty="jeszcze nie sprawdzano" />
              {data.lastError !== null ? (
                <>
                  {' '}
                  · ostatnie udane: <Ago iso={data.lastSuccessAt} now={now} timeZone={timeZone} empty="brak" />
                </>
              ) : null}
            </p>
            <AvailableVersion
              state={data}
              busy={busy}
              canChange={csrfToken !== null}
              onInstall={(version) => void installVersion(version)}
              timeZone={timeZone}
            />
            {csrfToken === null ? null : (
              <div className={styles.actions}>
                <button type="button" className={styles.button} disabled={busy} onClick={() => void check()}>
                  <RefreshCw size={16} aria-hidden="true" className={checking ? styles.spin : undefined} />
                  {checking ? 'Sprawdzanie…' : 'Sprawdź aktualizacje'}
                </button>
              </div>
            )}
          </>
        ) : (
          <p className={styles.muted}>Ta wersja aplikacji nie ma skonfigurowanego sprawdzania aktualizacji.</p>
        )}
        <p role="status" aria-live="polite" className={message?.error ? styles.danger : styles.muted}>
          {message?.text ?? ''}
        </p>
      </section>

      {data.configured ? (
        <section className={styles.card} aria-labelledby={`${uid}-auto`}>
          <h3 id={`${uid}-auto`} className={styles.cardTitle}>
            Automatyczne sprawdzanie
          </h3>
          <div className={styles.switchRow}>
            <span id={`${uid}-auto-label`}>Automatycznie sprawdzaj aktualizacje</span>
            <button
              type="button"
              role="switch"
              aria-checked={data.automatic}
              aria-labelledby={`${uid}-auto-label`}
              className={styles.switch}
              disabled={busy || csrfToken === null}
              onClick={() => void toggle()}
            >
              <span className={styles.knob} aria-hidden="true" />
            </button>
          </div>
          <p className={styles.strong}>
            {data.automatic ? (
              <>
                Aktualizacje są sprawdzane raz w tygodniu. Następne sprawdzenie:{' '}
                {data.nextCheckAt === null ? 'wkrótce' : formatDateTime(data.nextCheckAt, timeZone)}.
              </>
            ) : (
              'Wyłączone — sprawdzaj aktualizacje ręcznie.'
            )}
          </p>
          <p className={styles.muted}>
            Serwer sam sprawdza, czy jest nowa wersja, i przypomina o niej w pasku górnym. Niczego nie instaluje bez
            Twojej zgody. Sprawdzenie pobiera tylko podpisaną informację o najnowszej wersji — bez danych instalacji.
          </p>
        </section>
      ) : null}

      {install.last ? (
        <LastJob
          job={install.last}
          running={install.running}
          justInstalled={justInstalled}
          currentVersion={data.currentVersion}
          timeZone={timeZone}
        />
      ) : null}

      <section className={`${styles.card} ${styles.terminal}`} aria-labelledby={`${uid}-terminal`}>
        <div className={styles.jobHead}>
          <SquareTerminal size={20} aria-hidden="true" className={`${styles.icon} ${styles.accent}`} />
          <div>
            <h3 id={`${uid}-terminal`} className={`${styles.cardTitle} ${styles.accent}`}>
              Aktualizacja z terminala
            </h3>
            {data.available !== null && !install.supported ? (
              <p>Na tym serwerze instalacja z aplikacji jest niedostępna. Zainstaluj poleceniem:</p>
            ) : (
              <p>Aktualizację możesz też wykonać na serwerze, w terminalu, poleceniem:</p>
            )}
            <code className={styles.command}>{UPDATE_COMMAND}</code>
            <p className={styles.muted}>Robi kopię zapasową i przy błędzie wraca do poprzedniej wersji.</p>
          </div>
        </div>
      </section>
    </div>
  )
}
