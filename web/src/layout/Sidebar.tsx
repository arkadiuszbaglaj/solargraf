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
import { branding } from '../branding'
import styles from './Sidebar.module.css'

interface NavItem {
  label: string
  icon: LucideIcon
  available: boolean
}

const NAV: NavItem[] = [
  { label: 'Dashboard', icon: LayoutDashboard, available: true },
  { label: 'Instalacja', icon: SolarPanel, available: false },
  { label: 'Wykresy i historia', icon: ChartColumn, available: false },
  { label: 'Urządzenia', icon: Cpu, available: false },
  { label: 'Alarmy', icon: Bell, available: false },
  { label: 'Raporty', icon: FileText, available: false },
  { label: 'Ustawienia', icon: Settings, available: false },
]

export function Sidebar({ open, id }: { open: boolean; id: string }) {
  return (
    <aside id={id} className={`${styles.sidebar} ${open ? styles.open : ''}`}>
      <div className={styles.brand}>
        <span className={styles.name}>{branding.productName}</span>
        <span className={styles.status}>{branding.nameStatus}</span>
      </div>
      <nav aria-label="Główna nawigacja">
        <ul className={styles.nav}>
          {NAV.map(({ label, icon: Icon, available }) => (
            <li key={label}>
              {available ? (
                <a href="#main" className={`${styles.link} ${styles.active}`} aria-current="page">
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
