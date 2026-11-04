import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { ShoppingProvider } from './core/index.ts'
import { App } from './ui/App.tsx'
import './ui/global.css'

// The standalone page is an anonymous host: no identity, so the widget keeps its own id.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ShoppingProvider config={{ apiBaseUrl: '/api' }}>
      <App />
    </ShoppingProvider>
  </StrictMode>,
)
