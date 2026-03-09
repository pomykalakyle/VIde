import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import './app.css'

const container = document.getElementById('app')

if (!container) {
  throw new Error('The React renderer could not find the #app mount point.')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
