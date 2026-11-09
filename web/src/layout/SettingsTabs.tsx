import { INVERTER_SETTINGS_PATH, SERVER_HEALTH_PATH, UPDATES_PATH } from '../paths'
import styles from './SettingsTabs.module.css'

export type SettingsTab = 'server' | 'inverter' | 'updates'

const TABS: { tab: SettingsTab; label: string; href: string }[] = [
  { tab: 'server', label: 'Stan serwera', href: SERVER_HEALTH_PATH },
  { tab: 'inverter', label: 'Falownik', href: INVERTER_SETTINGS_PATH },
  { tab: 'updates', label: 'Aktualizacje', href: UPDATES_PATH },
]

/** Zakładki Ustawień (tylko OWNER — dostęp i tak sprawdza serwer). Zwykłe odnośniki, bez stanu. */
export function SettingsTabs({ current }: { current: SettingsTab }) {
  return (
    <nav aria-label="Ustawienia" className={styles.tabs}>
      <ul className={styles.list}>
        {TABS.map(({ tab, label, href }) => (
          <li key={tab}>
            <a
              href={href}
              className={tab === current ? `${styles.tab} ${styles.current}` : styles.tab}
              aria-current={tab === current ? 'page' : undefined}
            >
              {label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}
