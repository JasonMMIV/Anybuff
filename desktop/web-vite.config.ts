import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// M-A3: pure web build of the same renderer bundle — the artifact consumed by
// the Phase-B Android WebView (assets/www) and by the browser-preview smoke.
// Same root/alias as the electron-vite renderer section; base './' so the
// bundle loads from a file-ish origin (WebViewAssetLoader) with relative asset
// URLs. WS host injection is unchanged: main.tsx backs window.AnyBuff from
// window.__ANYBUFF_WS_URL__ (Android-injected) or the ?ws= query param.

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [react()],
  base: './',
  build: {
    outDir: resolve(__dirname, 'dist-web'),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
    },
  },
  preview: { port: 5199, strictPort: true },
})
