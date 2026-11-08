import { App } from './App'
import { safeNext, takeLoginEmail } from './api/auth'
import { AuthGate } from './auth/AuthGate'
import { ApiDataSource } from './data/api/ApiDataSource'
import { DataSourceProvider } from './data/DataSourceContext'
import { DemoDataSource } from './data/demo/DemoDataSource'
import { LoginPage } from './pages/LoginPage'
import { SetupPage, takeTokenFromLocation } from './pages/SetupPage'
import { CHARTS_PATH, SERVER_HEALTH_PATH, UPDATES_PATH } from './paths'

export type Route = 'setup' | 'login' | 'sites' | 'devices' | 'history' | 'server' | 'updates' | 'charts' | 'app'

export { CHARTS_PATH, SERVER_HEALTH_PATH, UPDATES_PATH }

const DEVICES_PATH = /^\/instalacje\/([0-9a-f-]{36})\/urzadzenia\/?$/i

/** Identyfikator instalacji z adresu `/instalacje/{id}/urzadzenia`. */
export function devicesSiteId(pathname: string): string | null {
  return DEVICES_PATH.exec(pathname)?.[1] ?? null
}

const HISTORY_PATH = /^\/instalacje\/([0-9a-f-]{36})\/urzadzenia\/([0-9a-f-]{36})\/historia\/?$/i

/** Instalacja i urządzenie z adresu `/instalacje/{id}/urzadzenia/{did}/historia` (D47). */
export function historyIds(pathname: string): { siteId: string; deviceId: string } | null {
  const m = HISTORY_PATH.exec(pathname)
  return m?.[1] && m[2] ? { siteId: m[1], deviceId: m[2] } : null
}

export function routeFor(pathname: string): Route {
  if (pathname === '/setup') return 'setup'
  if (pathname === '/login') return 'login'
  if (pathname === '/instalacje') return 'sites'
  if (pathname === SERVER_HEALTH_PATH || pathname === `${SERVER_HEALTH_PATH}/`) return 'server'
  if (pathname === UPDATES_PATH || pathname === `${UPDATES_PATH}/`) return 'updates'
  if (pathname === CHARTS_PATH || pathname === `${CHARTS_PATH}/`) return 'charts'
  if (devicesSiteId(pathname)) return 'devices'
  if (historyIds(pathname)) return 'history'
  return 'app'
}

// Tylko serwer deweloperski Vite bez backendu: `VITE_SKIP_AUTH=1 npm run dev`.
// W buildzie produkcyjnym `import.meta.env.DEV` jest stałą `false`.
const skipAuth = import.meta.env.DEV && import.meta.env.VITE_SKIP_AUTH === '1'

export function Root() {
  const route = routeFor(window.location.pathname)
  if (route === 'setup') {
    return <SetupPage token={takeTokenFromLocation()} />
  }
  if (route === 'login') {
    const params = new URLSearchParams(window.location.search)
    return (
      <LoginPage
        initialEmail={takeLoginEmail()}
        next={safeNext(params.get('next'))}
        expired={params.get('reason') === 'expired'}
      />
    )
  }
  // DEMO tylko w serwerze deweloperskim bez backendu; z backendem dane z API i SSE (D50).
  const dashboard = (
    <DataSourceProvider source={skipAuth ? new DemoDataSource() : new ApiDataSource()}>
      {route === 'devices' ? (
        <App page="devices" siteId={devicesSiteId(window.location.pathname) ?? ''} />
      ) : route === 'history' ? (
        <App
          page="history"
          siteId={historyIds(window.location.pathname)?.siteId ?? ''}
          deviceId={historyIds(window.location.pathname)?.deviceId ?? ''}
        />
      ) : (
        <App page={route === 'sites' || route === 'server' || route === 'updates' || route === 'charts' ? route : 'dashboard'} />
      )}
    </DataSourceProvider>
  )
  return skipAuth ? dashboard : <AuthGate>{dashboard}</AuthGate>
}
