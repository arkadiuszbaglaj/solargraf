import { useId, useState } from 'react'
import { WidgetState } from './components/WidgetState'
import { useDataSource } from './data/DataSourceContext'
import { useAsync } from './hooks/useAsync'
import { useNow } from './hooks/useNow'
import { Sidebar } from './layout/Sidebar'
import { Topbar } from './layout/Topbar'
import { DashboardPage } from './pages/DashboardPage'
import styles from './App.module.css'

export function App({ now: fixedNow }: { now?: Date } = {}) {
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
      <Sidebar open={menuOpen} id={menuId} />
      <div className={styles.content}>
        <Topbar
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
          {state.status !== 'ready' ? (
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
