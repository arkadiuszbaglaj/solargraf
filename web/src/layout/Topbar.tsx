import { LogOut, Menu } from 'lucide-react'
import { useId } from 'react'
import { useOptionalSession } from '../auth/SessionContext'
import { DemoBadge } from '../components/DemoBadge'
import type { Origin, Site } from '../data/types'
import { formatDateTime } from '../lib/format'
import styles from './Topbar.module.css'

export function Topbar({
  title = 'Dashboard',
  subtitle = 'Podgląd bieżących parametrów instalacji',
  showSiteSwitcher = true,
  sites,
  siteId,
  onSiteChange,
  now,
  origin,
  menuOpen,
  onToggleMenu,
  menuId,
}: {
  title?: string
  subtitle?: string
  showSiteSwitcher?: boolean
  sites: Site[]
  siteId: string
  onSiteChange: (id: string) => void
  now: Date
  origin: Origin
  menuOpen: boolean
  onToggleMenu: () => void
  menuId: string
}) {
  const selectId = useId()
  const site = sites.find((s) => s.id === siteId)
  const auth = useOptionalSession()
  return (
    <header className={styles.topbar} data-print="hide">
      <button
        type="button"
        className={styles.menuButton}
        aria-expanded={menuOpen}
        aria-controls={menuId}
        onClick={onToggleMenu}
      >
        <Menu size={20} aria-hidden="true" />
        <span className="visually-hidden">Menu</span>
      </button>
      <div className={styles.heading}>
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.subtitle}>{subtitle}</p>
      </div>
      <div className={styles.controls}>
        {showSiteSwitcher ? (
          <>
            <DemoBadge origin={origin} />
            <label htmlFor={selectId} className="visually-hidden">
              Instalacja
            </label>
            <select
              id={selectId}
              className={styles.select}
              value={siteId}
              onChange={(e) => onSiteChange(e.target.value)}
            >
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </>
        ) : null}
        {showSiteSwitcher && site ? (
          <time className={styles.clock} dateTime={now.toISOString()}>
            {formatDateTime(now.toISOString(), site.timezone)}
            <span className="visually-hidden"> (strefa {site.timezone})</span>
          </time>
        ) : null}
        {auth ? (
          <div className={styles.user}>
            <span className={styles.userName} title={auth.session.user.email}>
              {auth.session.user.displayName}
            </span>
            <button type="button" className={styles.logout} onClick={auth.logout} disabled={auth.loggingOut}>
              <LogOut size={16} aria-hidden="true" />
              {auth.loggingOut ? 'Wylogowywanie…' : 'Wyloguj'}
            </button>
          </div>
        ) : null}
      </div>
    </header>
  )
}
