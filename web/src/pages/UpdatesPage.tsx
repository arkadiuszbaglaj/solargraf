import { assignLocation, loginUrl } from '../api/auth'
import { browserTimeZone } from './ServerHealthPage'
import { UpdatesPanel } from './UpdatesPanel'
import styles from './ServerHealthPage.module.css'

/** Ustawienia → Aktualizacje (D63, D65): wersja, sprawdzanie i instalacja. Tylko OWNER (serwer). */
export function UpdatesPage({
  fetchFn = fetch,
  navigate = assignLocation,
  timeZone = browserTimeZone(),
}: {
  fetchFn?: typeof fetch
  navigate?: (url: string) => void
  timeZone?: string
}) {
  return (
    <div className={styles.page}>
      <UpdatesPanel fetchFn={fetchFn} onExpired={() => navigate(loginUrl('expired'))} timeZone={timeZone} />
    </div>
  )
}
