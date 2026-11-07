import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/global.css'
import { App } from './App'
import { DataSourceProvider } from './data/DataSourceContext'
import { DemoDataSource } from './data/demo/DemoDataSource'

const root = document.getElementById('root')
if (!root) {
  throw new Error('Brak elementu #root')
}

// Jedyne źródło danych do czasu API (P2/P5) to jawnie oznaczone DEMO.
const dataSource = new DemoDataSource()

createRoot(root).render(
  <StrictMode>
    <DataSourceProvider source={dataSource}>
      <App />
    </DataSourceProvider>
  </StrictMode>,
)
