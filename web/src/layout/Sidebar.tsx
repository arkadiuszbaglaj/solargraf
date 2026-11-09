import {
  Bell,
  ChartColumn,
  Cpu,
  FileText,
  LayoutDashboard,
  Settings,
  SolarPanel,
  type LucideIcon,
} from 'lucide-react'
import { useOptionalSession } from '../auth/SessionContext'
import { branding } from '../branding'
import { ALARMS_PATH, DEVICES_TAB_PATH, REPORTS_PATH } from '../paths'
import { AlarmNavBadge } from './AlarmNavBadge'
import styles from './Sidebar.module.css'

export type Page = 'dashboard' | 'sites' | 'charts' | 'devices' | 'alarms' | 'reports' | 'server'

interface NavItem {
  label: string
  icon: LucideIcon
  page?: Page
  href?: string
  /** Pozycja tylko dla roli OWNER (D60); dostęp i tak sprawdza serwer. */
  ownerOnly?: boolean
  /** Pozycja tylko dla ról OWNER i ADMIN (D74); dostęp i tak sprawdza serwer. */
  managerOnly?: boolean
}

const NAV: NavItem[] = [
  { label: 'Dashboard', icon: LayoutDashboard, page: 'dashboard', href: '/' },
  { label: 'Instalacje', icon: SolarPanel, page: 'sites', href: '/instalacje' },
  { label: 'Wykresy i historia', icon: ChartColumn, page: 'charts', href: '/wykresy' },
  { label: 'Urządzenia', icon: Cpu, page: 'devices', href: DEVICES_TAB_PATH },
  { label: 'Alarmy', icon: Bell, page: 'alarms', href: ALARMS_PATH },
  { label: 'Raporty', icon: FileText, page: 'reports', href: REPORTS_PATH, managerOnly: true },
  { label: 'Ustawienia', icon: Settings, page: 'server', href: '/ustawienia/serwer', ownerOnly: true },
]

export function Sidebar({
  open,
  id,
  current = 'dashboard',
  alarmSiteId = '',
}: {
  open: boolean
  id: string
  current?: Page
  /** Instalacja, której alarmy pokazuje znacznik przy „Alarmy”; puste — bez znacznika (np. DEMO). */
  alarmSiteId?: string
}) {
  const auth = useOptionalSession()
  const isOwner = auth?.session.memberships.some((m) => m.role === 'OWNER') ?? false
  // Bez sesji (DEMO w serwerze deweloperskim) pozycja jest widoczna — dane i tak z serwera.
  const isManager = auth ? auth.session.memberships.some((m) => m.role === 'OWNER' || m.role === 'ADMIN') : true
  return (
    <aside id={id} data-print="hide" className={`${styles.sidebar} ${open ? styles.open : ''}`}>
      <div className={styles.brand}>
        <span className={styles.name}>{branding.productName}</span>
        <span className={styles.status}>{branding.nameStatus}</span>
      </div>
      <nav aria-label="Główna nawigacja">
        <ul className={styles.nav}>
          {/* Raporty bez uprawnień są ukryte — nie „wkrótce”, bo funkcja istnieje. */}
          {NAV.filter((item) => !item.managerOnly || isManager).map(({ label, icon: Icon, page, href, ownerOnly }) => (
            <li key={label}>
              {href && (!ownerOnly || isOwner) ? (
                <a
                  href={href}
                  className={page === current ? `${styles.link} ${styles.active}` : styles.link}
                  aria-current={page === current ? 'page' : undefined}
                >
                  <Icon size={18} aria-hidden="true" />
                  {label}
                  {page === 'alarms' && alarmSiteId ? <AlarmNavBadge siteId={alarmSiteId} /> : null}
                </a>
              ) : (
                <span className={`${styles.link} ${styles.disabled}`} aria-disabled="true">
                  <Icon size={18} aria-hidden="true" />
                  {label}
                  <span className={styles.soon}>wkrótce</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  )
}
