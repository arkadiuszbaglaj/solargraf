import { useId, useState } from 'react'
import { WidgetState } from './components/WidgetState'
import { useDataSource } from './data/DataSourceContext'
import { useAsync } from './hooks/useAsync'
import { useNow } from './hooks/useNow'
import { Sidebar } from './layout/Sidebar'
import { Topbar } from './layout/Topbar'
import type { Page } from './layout/Sidebar'
import { DashboardPage } from './pages/DashboardPage'
import { DevicesPage } from './pages/DevicesPage'
import { SitesPage } from './pages/SitesPage'
import styles from './App.module.css'

export function App({
  now: fixedNow,
  page = 'dashboard',
  siteId: routeSiteId = '',
}: { now?: Date; page?: Page | 'devices'; siteId?: string } = {}) {
  const source = useDataSource()
  const tickingNow = useNow()
  const now = fixedNow ?? tickingNow
  const { state, reload } = useAsync((signal) => source.listSites(signal), [source])
  const [selected, setSelected] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuId = useId()

  const sites = state.status === 'ready' ? state.data : []
  const site = sites.find((s) => s.id === selected) ?? sites[0]

  return (
    <div className={styles.shell}>
      <a className={styles.skip} href="#main">
        Przejdź do treści
      </a>
      <Sidebar open={menuOpen} id={menuId} current={page === 'devices' ? 'sites' : page} />
      <div className={styles.content}>
        <Topbar
          {...(page === 'sites'
            ? { title: 'Instalacje', subtitle: 'Instalacje dostępne dla Twojego konta', showSiteSwitcher: false }
            : page === 'devices'
              ? { title: 'Urządzenia', subtitle: 'Urządzenia i połączenia instalacji', showSiteSwitcher: false }
              : {})}
          sites={sites}
          siteId={site?.id ?? ''}
          onSiteChange={setSelected}
          now={now}
          origin={source.origin}
          menuOpen={menuOpen}
          onToggleMenu={() => setMenuOpen((o) => !o)}
          menuId={menuId}
        />
        <main id="main" className={styles.main} tabIndex={-1}>
          {page === 'sites' ? (
            <SitesPage />
          ) : page === 'devices' ? (
            <DevicesPage siteId={routeSiteId} />
          ) : state.status !== 'ready' ? (
            <WidgetState
              status={state.status === 'loading' ? { kind: 'loading' } : { kind: 'error', onRetry: reload }}
            />
          ) : site ? (
            <DashboardPage key={site.id} site={site} now={now} />
          ) : (
            <WidgetState status={{ kind: 'empty', message: 'Brak instalacji do wyświetlenia.' }} />
          )}
        </main>
      </div>
    </div>
  )
}
