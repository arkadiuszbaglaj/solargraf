import { useId, useState } from 'react'
import { WidgetState } from './components/WidgetState'
import { useDataSource } from './data/DataSourceContext'
import { useAsync } from './hooks/useAsync'
import { useNow } from './hooks/useNow'
import { ClockSkewBanner } from './layout/ClockSkewBanner'
import { SettingsTabs } from './layout/SettingsTabs'
import { Sidebar } from './layout/Sidebar'
import { SystemAlarmBanner } from './layout/SystemAlarmBanner'
import { Topbar } from './layout/Topbar'
import { UpdateBanner } from './layout/UpdateBanner'
import type { Page } from './layout/Sidebar'
import { DashboardPage } from './pages/DashboardPage'
import { DeviceHistoryPage } from './pages/DeviceHistoryPage'
import { DevicesPage } from './pages/DevicesPage'
import { ServerHealthPage } from './pages/ServerHealthPage'
import { AlarmsPage } from './pages/AlarmsPage'
import { ReportsPage } from './pages/ReportsPage'
import { SiteChartsPage } from './pages/SiteChartsPage'
import { SitesPage } from './pages/SitesPage'
import { UpdatesPage } from './pages/UpdatesPage'
import { devicesUrl } from './paths'
import styles from './App.module.css'

type AppPage = Page | 'history' | 'updates'

/** Tytuł strony w pasku górnym; bez wpisu — dashboard z przełącznikiem instalacji. */
const TOPBAR: Partial<Record<AppPage, { title: string; subtitle: string; showSiteSwitcher?: boolean }>> = {
  sites: { title: 'Instalacje', subtitle: 'Instalacje dostępne dla Twojego konta', showSiteSwitcher: false },
  // Urządzenia instalacji wybranej w przełączniku; adres niesie wybór (odświeżenie, linki).
  devices: { title: 'Urządzenia', subtitle: 'Lista urządzeń i szczegółowe parametry' },
  history: { title: 'Historia', subtitle: 'Historia pomiarów urządzenia', showSiteSwitcher: false },
  // Wykresy instalacji (D66): instalację wybiera przełącznik w pasku górnym.
  charts: { title: 'Wykresy i historia', subtitle: 'Historia pomiarów instalacji' },
  alarms: { title: 'Alarmy', subtitle: 'Aktywne alarmy instalacji i zamknięte w ostatnich 24 h' },
  reports: { title: 'Raporty', subtitle: 'Bilans energii instalacji za miesiąc albo rok' },
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
  const [selected, setSelected] = useState<string | null>(routeSiteId || null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuId = useId()

  const sites = state.status === 'ready' ? state.data : []
  const site = sites.find((s) => s.id === selected) ?? sites[0]

  return (
    <div className={styles.shell}>
      <a className={styles.skip} href="#main">
        Przejdź do treści
      </a>
      <Sidebar open={menuOpen} id={menuId} current={page === 'history' ? 'devices' : page === 'updates' ? 'server' : page} />
      <div className={styles.content}>
        <Topbar
          {...TOPBAR[page]}
          sites={sites}
          siteId={site?.id ?? ''}
          onSiteChange={(id) => {
            setSelected(id)
            if (page === 'devices') window.history.replaceState(null, '', devicesUrl(id))
          }}
          now={now}
          origin={source.origin}
          menuOpen={menuOpen}
          onToggleMenu={() => setMenuOpen((o) => !o)}
          menuId={menuId}
        />
        {source.origin === 'DEMO' ? null : <ClockSkewBanner />}
        {source.origin === 'DEMO' ? null : <SystemAlarmBanner />}
        {source.origin === 'DEMO' ? null : <UpdateBanner />}
        <main id="main" className={styles.main} tabIndex={-1}>
          {page === 'sites' ? (
            <SitesPage />
          ) : page === 'server' || page === 'updates' ? (
            <>
              <SettingsTabs current={page} />
              {page === 'server' ? <ServerHealthPage /> : <UpdatesPage />}
            </>
          ) : page === 'history' ? (
            <DeviceHistoryPage siteId={routeSiteId} deviceId={routeDeviceId} now={now} />
          ) : state.status !== 'ready' ? (
            <WidgetState
              status={state.status === 'loading' ? { kind: 'loading' } : { kind: 'error', onRetry: reload }}
            />
          ) : site && page === 'devices' ? (
            <DevicesPage
              key={site.id}
              siteId={site.id}
              now={now}
              origin={source.origin}
              initialDeviceId={site.id === routeSiteId ? routeDeviceId : ''}
            />
          ) : site && page === 'alarms' ? (
            <AlarmsPage key={site.id} site={site} origin={source.origin} />
          ) : site && page === 'reports' ? (
            <ReportsPage key={site.id} site={site} now={now} origin={source.origin} />
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
