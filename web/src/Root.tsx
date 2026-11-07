import { App } from './App'
import { safeNext, takeLoginEmail } from './api/auth'
import { AuthGate } from './auth/AuthGate'
import { DataSourceProvider } from './data/DataSourceContext'
import { DemoDataSource } from './data/demo/DemoDataSource'
import { LoginPage } from './pages/LoginPage'
import { SetupPage, takeTokenFromLocation } from './pages/SetupPage'

export type Route = 'setup' | 'login' | 'sites' | 'app'

export function routeFor(pathname: string): Route {
  if (pathname === '/setup') return 'setup'
  if (pathname === '/login') return 'login'
  if (pathname === '/instalacje') return 'sites'
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
  // Jedyne źródło danych do czasu API (P2/P5) to jawnie oznaczone DEMO.
  const dashboard = (
    <DataSourceProvider source={new DemoDataSource()}>
      <App page={route === 'sites' ? 'sites' : 'dashboard'} />
    </DataSourceProvider>
  )
  return skipAuth ? dashboard : <AuthGate>{dashboard}</AuthGate>
}
