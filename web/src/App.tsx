import { useId, useState } from 'react'
import { WidgetState } from './components/WidgetState'
import { useDataSource } from './data/DataSourceContext'
import { useAsync } from './hooks/useAsync'
import { useNow } from './hooks/useNow'
import { ClockSkewBanner } from './layout/ClockSkewBanner'
import { SettingsTabs } from './layout/SettingsTabs'
import { Sidebar } from './layout/Sidebar'
import { Topbar } from './layout/Topbar'
import { UpdateBanner } from './layout/UpdateBanner'
import type { Page } from './layout/Sidebar'
import { DashboardPage } from './pages/DashboardPage'
import { DeviceHistoryPage } from './pages/DeviceHistoryPage'
import { DevicesPage } from './pages/DevicesPage'
import { ServerHealthPage } from './pages/ServerHealthPage'
import { SiteChartsPage } from './pages/SiteChartsPage'
import { SitesPage } from './pages/SitesPage'
import { UpdatesPage } from './pages/UpdatesPage'
import styles from './App.module.css'

type AppPage = Page | 'devices' | 'history' | 'updates'

/** Tytuł strony w pasku górnym; bez wpisu — dashboard z przełącznikiem instalacji. */
const TOPBAR: Partial<Record<AppPage, { title: string; subtitle: string; showSiteSwitcher?: boolean }>> = {
  sites: { title: 'Instalacje', subtitle: 'Instalacje dostępne dla Twojego konta', showSiteSwitcher: false },
  devices: { title: 'Urządzenia', subtitle: 'Urządzenia i połączenia instalacji', showSiteSwitcher: false },
  history: { title: 'Historia', subtitle: 'Historia pomiarów urządzenia', showSiteSwitcher: false },
  // Wykresy instalacji (D66): instalację wybiera przełącznik w pasku górnym.
  charts: { title: 'Wykresy i historia', subtitle: 'Historia pomiarów instalacji' },
  server: { title: 'Stan serwera', subtitle: 'Zasoby, składniki i ocena stabilności', showSiteSwitcher: false },
  updates: {
    title: 'Aktualizacje',
    subtitle: 'Wersja aplikacji, sprawdzanie i instalacja aktualizacji',
    showSiteSwitcher: false,
  },
}

export function App({
  now: fixedNow,
  page = 'dashboard',
  siteId: routeSiteId = '',
  deviceId: routeDeviceId = '',
}: { now?: Date; page?: AppPage; siteId?: string; deviceId?: string } = {}) {
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
      <Sidebar open={menuOpen} id={menuId} current={page === 'devices' || page === 'history' ? 'sites' : page === 'updates' ? 'server' : page} />
      <div className={styles.content}>
        <Topbar
          {...TOPBAR[page]}
          sites={sites}
          siteId={site?.id ?? ''}
          onSiteChange={setSelected}
          now={now}
          origin={source.origin}
          menuOpen={menuOpen}
          onToggleMenu={() => setMenuOpen((o) => !o)}
          menuId={menuId}
        />
        {source.origin === 'DEMO' ? null : <ClockSkewBanner />}
        {source.origin === 'DEMO' ? null : <UpdateBanner />}
        <main id="main" className={styles.main} tabIndex={-1}>
          {page === 'sites' ? (
            <SitesPage />
          ) : page === 'server' || page === 'updates' ? (
            <>
              <SettingsTabs current={page} />
              {page === 'server' ? <ServerHealthPage /> : <UpdatesPage />}
            </>
          ) : page === 'devices' ? (
            <DevicesPage siteId={routeSiteId} />
          ) : page === 'history' ? (
            <DeviceHistoryPage siteId={routeSiteId} deviceId={routeDeviceId} now={now} />
          ) : state.status !== 'ready' ? (
            <WidgetState
              status={state.status === 'loading' ? { kind: 'loading' } : { kind: 'error', onRetry: reload }}
            />
          ) : site && page === 'charts' ? (
            <SiteChartsPage key={site.id} site={site} now={now} origin={source.origin} />
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
