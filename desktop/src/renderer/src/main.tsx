import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import { createWsAnyBuff } from './host/host-ws'

// M-A3 / Phase B: when this renderer bundle runs inside a WebView (Android) or
// a plain browser (preview) there is no Electron preload, so window.AnyBuff is
// undefined. If a WS host URL is provided (Android: injected via
// window.__ANYBUFF_WS_URL__; preview: ?ws=… query param), back the API with the
// headless host-core WebSocket before React mounts.
function resolveWsUrl(): string | null {
  if (typeof window !== 'undefined') {
    const injected = (window as unknown as { __ANYBUFF_WS_URL__?: string }).__ANYBUFF_WS_URL__
    if (injected) return injected
    const q = new URLSearchParams(window.location.search).get('ws')
    if (q) return q
  }
  return null
}

const wsUrl = typeof window.AnyBuff === 'undefined' ? resolveWsUrl() : null
if (wsUrl) {
  // The WS host is async (first request opens the socket lazily per call), but
  // the renderer calls methods immediately on mount. Pre-connect by making the
  // socket eagerly — createWsAnyBuff opens on construction already.
  window.AnyBuff = createWsAnyBuff({ url: wsUrl }) as never
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
