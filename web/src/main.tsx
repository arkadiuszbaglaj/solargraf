import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/global.css'
import { Root } from './Root'

const root = document.getElementById('root')
if (!root) {
  throw new Error('Brak elementu #root')
}

createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
