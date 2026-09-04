import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import { createWsAnyBuff, type AnyBuffNativeBridge } from './host/host-ws'

// M-A3 / Phase B: when this renderer bundle runs inside a WebView (Android) or
// a plain browser (preview) there is no Electron preload, so window.AnyBuff is
// undefined. If a WS host URL is provided (Android: injected via
// window.__ANYBUFF_WS_URL__; preview: ?ws=… query param), back the API with the
// headless host-core WebSocket before React mounts.
//
// Optional globals the shell may inject alongside the WS URL (Phase B):
//   __ANYBUFF_APP_VERSION__  installed app version (getAppVersion)
//   __ANYBUFF_UPDATE_REPO__  GitHub repo "owner/repo" enabling the About-tab
//                            update check (v1: version compare + download link)
//   __ANYBUFF_NATIVE__       native bridge object ({ pickFolder, pickFiles,
//                            openExternal, getVersion }) — WebView JS cannot open
//                            SAF pickers / external browsers by itself.
function resolveWsUrl(): string | null {
  if (typeof window !== 'undefined') {
    const injected = (window as unknown as { __ANYBUFF_WS_URL__?: string }).__ANYBUFF_WS_URL__
    if (injected) return injected
    const q = new URLSearchParams(window.location.search).get('ws')
    if (q) return q
  }
  return null
}

interface WebviewGlobals {
  __ANYBUFF_WS_URL__?: string
  __ANYBUFF_APP_VERSION__?: string
  __ANYBUFF_UPDATE_REPO__?: string
  __ANYBUFF_NATIVE__?: AnyBuffNativeBridge
}

const wsUrl = typeof window.AnyBuff === 'undefined' ? resolveWsUrl() : null
if (wsUrl) {
  const g = (typeof window !== 'undefined' ? (window as unknown as WebviewGlobals) : {}) as WebviewGlobals
  // The WS host is async (first request opens the socket lazily per call), but
  // the renderer calls methods immediately on mount. Pre-connect by making the
  // socket eagerly — createWsAnyBuff opens on construction already.
  window.AnyBuff = createWsAnyBuff({
    url: wsUrl,
    appVersion: g.__ANYBUFF_APP_VERSION__,
    updateRepo: g.__ANYBUFF_UPDATE_REPO__,
    native: g.__ANYBUFF_NATIVE__,
  }) as never

  // WebView / browser-shell host (no Electron frame): the desktop titlebar
  // chrome (File/Edit/View menus, min/max/close) is irrelevant here — mark the
  // document so CSS can hide it. Electron never enters this branch.
  document.documentElement.classList.add('is-webview')
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
