import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/global.css'
import { App } from './App'
import { DataSourceProvider } from './data/DataSourceContext'
import { DemoDataSource } from './data/demo/DemoDataSource'
import { SetupPage, takeTokenFromLocation } from './pages/SetupPage'

const root = document.getElementById('root')
if (!root) {
  throw new Error('Brak elementu #root')
}

// Pierwsza konfiguracja (D31, D34): jednorazowy link z instalatora.
if (window.location.pathname === '/setup') {
  createRoot(root).render(
    <StrictMode>
      <SetupPage token={takeTokenFromLocation()} />
    </StrictMode>,
  )
} else {
  // Jedyne źródło danych do czasu API (P2/P5) to jawnie oznaczone DEMO.
  const dataSource = new DemoDataSource()

  createRoot(root).render(
    <StrictMode>
      <DataSourceProvider source={dataSource}>
        <App />
      </DataSourceProvider>
    </StrictMode>,
  )
}
