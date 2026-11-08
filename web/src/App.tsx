import { useId, useState } from 'react'
import { WidgetState } from './components/WidgetState'
import { useDataSource } from './data/DataSourceContext'
import { useAsync } from './hooks/useAsync'
import { useNow } from './hooks/useNow'
import { ClockSkewBanner } from './layout/ClockSkewBanner'
import { Sidebar } from './layout/Sidebar'
import { Topbar } from './layout/Topbar'
import { UpdateBanner } from './layout/UpdateBanner'
import type { Page } from './layout/Sidebar'
import { DashboardPage } from './pages/DashboardPage'
import { DeviceHistoryPage } from './pages/DeviceHistoryPage'
import { DevicesPage } from './pages/DevicesPage'
import { ServerHealthPage } from './pages/ServerHealthPage'
import { SitesPage } from './pages/SitesPage'
import styles from './App.module.css'

export function App({
  now: fixedNow,
  page = 'dashboard',
  siteId: routeSiteId = '',
  deviceId: routeDeviceId = '',
}: { now?: Date; page?: Page | 'devices' | 'history'; siteId?: string; deviceId?: string } = {}) {
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
      <Sidebar open={menuOpen} id={menuId} current={page === 'devices' || page === 'history' ? 'sites' : page} />
      <div className={styles.content}>
        <Topbar
          {...(page === 'sites'
            ? { title: 'Instalacje', subtitle: 'Instalacje dostępne dla Twojego konta', showSiteSwitcher: false }
            : page === 'devices'
              ? { title: 'Urządzenia', subtitle: 'Urządzenia i połączenia instalacji', showSiteSwitcher: false }
              : page === 'history'
                ? { title: 'Historia', subtitle: 'Historia pomiarów urządzenia', showSiteSwitcher: false }
                : page === 'server'
                  ? { title: 'Stan serwera', subtitle: 'Zasoby, składniki i ocena stabilności', showSiteSwitcher: false }
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
        {source.origin === 'DEMO' ? null : <ClockSkewBanner />}
        {source.origin === 'DEMO' ? null : <UpdateBanner />}
        <main id="main" className={styles.main} tabIndex={-1}>
          {page === 'sites' ? (
            <SitesPage />
          ) : page === 'server' ? (
            <ServerHealthPage />
          ) : page === 'devices' ? (
            <DevicesPage siteId={routeSiteId} />
          ) : page === 'history' ? (
            <DeviceHistoryPage siteId={routeSiteId} deviceId={routeDeviceId} now={now} />
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
