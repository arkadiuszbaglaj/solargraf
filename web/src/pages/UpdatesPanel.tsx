import { useState } from 'react'
import type { ChangeResult, UpdatesState } from '../api/updates'
import { checkUpdates, getUpdates, setAutomaticCheck } from '../api/updates'
import { useOptionalSession } from '../auth/SessionContext'
import { Panel } from '../components/Panel'
import { WidgetState } from '../components/WidgetState'
import { usePeriodic } from '../hooks/usePeriodic'
import { formatDateTime } from '../lib/format'
import { CHECK_ERROR_TEXT } from '../lib/updates'
import styles from './ServerHealthPage.module.css'

/** Stan zmienia worker najwyżej raz na dobę — częste odświeżanie nic nie wnosi. */
export const UPDATES_REFRESH_MS = 5 * 60_000

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
        Aktualizację instalujesz ręcznie na serwerze; przed nią wykonaj kopię: <code>sudo solargraf backup</code>.{' '}
        <a href={a.infoUrl} target="_blank" rel="noopener noreferrer">
          Informacje o wydaniu
        </a>
      </p>
    </div>
  )
}

/** Ustawienia → Stan serwera → Aktualizacje (D15, D63). Dostęp sprawdza serwer — tylko OWNER. */
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
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)

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
  if (state.data.kind === 'forbidden') return null
  const loaded = state.data
  const data = override?.base === loaded ? override.data : loaded.data

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

  const check = () =>
    run(
      (token) => checkUpdates(token, fetchFn),
      (next) =>
        next.lastCheckedAt === data.lastCheckedAt
          ? 'Sprawdzono przed chwilą — kolejne sprawdzenie będzie możliwe za minutę.'
          : next.lastError === null
            ? 'Sprawdzono.'
            : 'Nie udało się sprawdzić aktualizacji.',
    )
  const toggle = () =>
    run(
      (token) => setAutomaticCheck(!data.automatic, token, fetchFn),
      (next) => (next.automatic ? 'Automatyczne sprawdzanie włączone.' : 'Automatyczne sprawdzanie wyłączone.'),
    )

  const time = (iso: string | null, empty: string): string => (iso === null ? empty : formatDateTime(iso, timeZone))

  return (
    <Panel title="Aktualizacje">
      <WidgetState
        status={{ kind: 'ready' }}
        staleNotice={state.failed ? 'Nie udało się odświeżyć — stan z poprzedniego pobrania.' : null}
      >
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
            {csrfToken === null ? null : (
              <div className={styles.updateActions}>
                <label className={styles.checkbox}>
                  <input type="checkbox" checked={data.automatic} disabled={busy} onChange={() => void toggle()} />
                  Sprawdzaj automatycznie raz w tygodniu
                </label>
                <button type="button" className={styles.button} disabled={busy} onClick={() => void check()}>
                  {busy ? 'Sprawdzanie…' : 'Sprawdź aktualizacje'}
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
