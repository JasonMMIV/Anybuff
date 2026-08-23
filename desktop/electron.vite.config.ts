import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// Explicit outDirs anchored to desktop/ — inside a bun monorepo electron-vite
// would otherwise resolve the default "out" against the repo root.
const r = (p: string) => resolve(__dirname, p)

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: r('out/main'),
      rollupOptions: {
        // @codebuff/sdk 與 WASM 依賴在 main process 以 Node 原生方式載入，
        // 不交由 bundle，避免 WASM 路徑解析問題。
        external: ['@codebuff/sdk']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: r('out/preload') }
  },
  renderer: {
    plugins: [react()],
    root: r('src/renderer'),
    build: { outDir: r('out/renderer') },
    resolve: {
      alias: {
        '@renderer': r('src/renderer/src')
      }
    }
  }
})
