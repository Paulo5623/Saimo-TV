import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './styles/dpad-navigation.css'
import App from './App.tsx'
import { iniciar as iniciarTelemetria } from './services/telemetria'

iniciarTelemetria()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
