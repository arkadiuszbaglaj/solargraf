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
import styles from './Sidebar.module.css'

export type Page = 'dashboard' | 'sites' | 'server'

interface NavItem {
  label: string
  icon: LucideIcon
  page?: Page
  href?: string
  /** Pozycja tylko dla roli OWNER (D60); dostęp i tak sprawdza serwer. */
  ownerOnly?: boolean
}

const NAV: NavItem[] = [
  { label: 'Dashboard', icon: LayoutDashboard, page: 'dashboard', href: '/' },
  { label: 'Instalacje', icon: SolarPanel, page: 'sites', href: '/instalacje' },
  { label: 'Wykresy i historia', icon: ChartColumn },
  { label: 'Urządzenia', icon: Cpu },
  { label: 'Alarmy', icon: Bell },
  { label: 'Raporty', icon: FileText },
  { label: 'Ustawienia', icon: Settings, page: 'server', href: '/ustawienia/serwer', ownerOnly: true },
]

export function Sidebar({ open, id, current = 'dashboard' }: { open: boolean; id: string; current?: Page }) {
  const auth = useOptionalSession()
  const isOwner = auth?.session.memberships.some((m) => m.role === 'OWNER') ?? false
  return (
    <aside id={id} className={`${styles.sidebar} ${open ? styles.open : ''}`}>
      <div className={styles.brand}>
        <span className={styles.name}>{branding.productName}</span>
        <span className={styles.status}>{branding.nameStatus}</span>
      </div>
      <nav aria-label="Główna nawigacja">
        <ul className={styles.nav}>
          {NAV.map(({ label, icon: Icon, page, href, ownerOnly }) => (
            <li key={label}>
              {href && (!ownerOnly || isOwner) ? (
                <a
                  href={href}
                  className={page === current ? `${styles.link} ${styles.active}` : styles.link}
                  aria-current={page === current ? 'page' : undefined}
                >
                  <Icon size={18} aria-hidden="true" />
                  {label}
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
