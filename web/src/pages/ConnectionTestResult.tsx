import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionTest, TestErrorCode, TestTarget } from '../api/devices'
import { getConnectionTest, requestConnectionTest } from '../api/devices'
import { DemoBadge } from '../components/DemoBadge'
import { formatValue } from '../components/historyChartOption'
import { MISSING } from '../lib/format'
import styles from './DevicesPage.module.css'

/** Co ile UI pyta o wynik; agent odbiera zlecenia co 5 s (D72). */
export const TEST_POLL_MS = 2_000
/** Po tym czasie UI przestaje czekać (serwer i tak oznaczy zlecenie jako wygasłe). */
export const TEST_GIVE_UP_MS = 150_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const wallClock = (): number => Date.now()

export type TestRun =
  | { status: 'idle' }
  | { status: 'waiting'; test: ConnectionTest | null }
  | { status: 'done'; test: ConnectionTest }
  | { status: 'expired' }
  | { status: 'error'; message: string }

export const TEST_ERROR_LABEL: Record<TestErrorCode, string> = {
  TIMEOUT: 'Urządzenie nie odpowiedziało w czasie — sprawdź adres, port i czy urządzenie jest włączone.',
  CONNECTION_REFUSED: 'Połączenie odrzucone — pod tym adresem i portem nie działa serwer Modbus TCP.',
  CONNECTION_LOST: 'Połączenie zostało przerwane w trakcie odczytu.',
  MODBUS_EXCEPTION: 'Urządzenie odrzuciło część zapytań — sprawdź Unit ID i zgodność profilu z modelem.',
  INVALID_RESPONSE: 'Niepoprawna odpowiedź urządzenia — profil może nie pasować do modelu.',
  UNKNOWN_PROFILE: 'Agent nie zna tego profilu — zaktualizuj oprogramowanie.',
  TARGET_IN_USE: 'Agent już odczytuje urządzenie pod tym adresem — prawdopodobnie jest ono już dodane.',
}

/** Zlecenie testu i odpytywanie o wynik aż do DONE/EXPIRED; anulowane przy odmontowaniu i resecie. */
export function useConnectionTest(
  siteId: string,
  csrfToken: string,
  fetchFn: typeof fetch,
  onExpired: () => void,
  wait: (ms: number) => Promise<void> = sleep,
  clock: () => number = wallClock,
) {
  const [run, setRun] = useState<TestRun>({ status: 'idle' })
  const generation = useRef(0)

  useEffect(
    () => () => {
      generation.current += 1
    },
    [],
  )

  const reset = useCallback(() => {
    generation.current += 1
    setRun({ status: 'idle' })
  }, [])

  const start = useCallback(
    async (target: TestTarget) => {
      const mine = ++generation.current
      const current = () => generation.current === mine
      setRun({ status: 'waiting', test: null })
      const created = await requestConnectionTest(siteId, target, csrfToken, fetchFn)
      if (!current()) return
      if (!created.ok) {
        if (created.anonymous) onExpired()
        setRun({ status: 'error', message: created.message })
        return
      }
      const deadline = clock() + TEST_GIVE_UP_MS
      let test = created.data
      while (test.state === 'PENDING' || test.state === 'RUNNING') {
        setRun({ status: 'waiting', test })
        if (clock() > deadline) {
          setRun({ status: 'expired' })
          return
        }
        // Odpytywanie jest celowo sekwencyjne — kolejne zapytanie dopiero po poprzednim.
        // oxlint-disable-next-line no-await-in-loop
        await wait(TEST_POLL_MS)
        if (!current()) return
        // oxlint-disable-next-line no-await-in-loop
        const next = await getConnectionTest(siteId, test.id, fetchFn)
        if (!current()) return
        if (next.kind === 'anonymous') {
          onExpired()
          setRun({ status: 'error', message: 'Sesja wygasła.' })
          return
        }
        // Chwilowy błąd sieci — próbujemy dalej do terminu.
        if (next.kind === 'ok') test = next.data
      }
      setRun(test.state === 'EXPIRED' ? { status: 'expired' } : { status: 'done', test })
    },
    [siteId, csrfToken, fetchFn, onExpired, wait, clock],
  )

  return { run, start, reset }
}

/** Wynik testu: werdykt, przyczyna błędu i odczytane wartości (brak to „—”, nie 0). */
export function ConnectionTestResult({ run }: { run: TestRun }) {
  if (run.status === 'idle') return null
  if (run.status === 'waiting') {
    return (
      <p role="status" className={styles.muted}>
        {run.test?.state === 'RUNNING' ? 'Agent łączy się z urządzeniem…' : 'Czekam, aż agent odbierze zlecenie…'}
      </p>
    )
  }
  if (run.status === 'error') {
    return (
      <p role="alert" className={styles.error}>
        {run.message}
      </p>
    )
  }
  if (run.status === 'expired') {
    return (
      <p role="alert" className={styles.error}>
        Agent nie wykonał testu na czas. Sprawdź, czy agent działa (Ustawienia → System), i spróbuj ponownie.
      </p>
    )
  }
  const { test } = run
  const good = test.readings.filter((r) => r.quality === 'GOOD').length
  // Agent odmówił testu (adres zajęty, nieznany profil) — to nie awaria urządzenia.
  const skipped = test.errorCode === 'TARGET_IN_USE' || test.errorCode === 'UNKNOWN_PROFILE'
  const verdict = skipped
    ? { kind: 'warn', text: 'Test nie został wykonany.' }
    : test.result === 'OK'
      ? { kind: 'ok', text: 'Połączenie działa — odczytano wszystkie parametry profilu.' }
      : test.result === 'PARTIAL'
        ? { kind: 'warn', text: 'Połączenie działa, ale części parametrów nie odczytano.' }
        : { kind: 'error', text: 'Nie udało się odczytać urządzenia.' }
  return (
    <div className={styles.testResult} role="status">
      <p className={verdict.kind === 'ok' ? styles.ok : verdict.kind === 'warn' ? styles.warn : styles.error}>
        <strong>{verdict.text}</strong>
        {test.origin === 'SIMULATED' ? <DemoBadge origin="SIMULATED" /> : null}
      </p>
      {test.errorCode ? <p className={styles.muted}>{TEST_ERROR_LABEL[test.errorCode]}</p> : null}
      {test.readings.length > 0 && good === 0 ? (
        <p className={styles.muted}>Nie odczytano żadnego z {test.readings.length} parametrów profilu.</p>
      ) : null}
      {good > 0 ? (
        <>
          <p className={styles.muted}>
            Odczytano {good} z {test.readings.length} parametrów profilu.
          </p>
          <table className={styles.values}>
            <caption className="visually-hidden">Wartości odczytane w teście połączenia</caption>
            <thead>
              <tr>
                <th scope="col">Parametr</th>
                <th scope="col">Wartość</th>
              </tr>
            </thead>
            <tbody>
              {test.readings.map((r) => (
                <tr key={`${r.metric}|${r.channel ?? ''}`}>
                  <th scope="row">{r.channel === null ? r.name : `${r.name} ${r.channel}`}</th>
                  <td>
                    {r.quality === 'GOOD'
                      ? formatValue(r.value, r.unit)
                      : `${MISSING} ${r.quality === 'INVALID' ? '(niepoprawna wartość)' : '(brak odczytu)'}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </div>
  )
}
