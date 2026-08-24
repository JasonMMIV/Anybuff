/**
 * Packaged-mode entry point (desktop/package.json "main").
 *
 * Why this exists: @codebuff/sdk is externalized in the main-process bundle
 * (electron.vite.config.ts), and common/env.ts validates the NEXT_PUBLIC_*
 * variables the moment the SDK is evaluated. ESM evaluates external
 * dependencies BEFORE the bundle's own module bodies, so the in-bundle
 * env-shim (src/main/env-shim.ts) always runs too late. Dev mode masks this
 * via scripts/dev-launcher.mjs; the packaged app has no launcher, so without
 * this file the app dies at startup with "Invalid environment configuration".
 *
 * This file is raw CJS (never bundled), so it runs before any ESM import
 * hoisting can pull in the SDK. Defaults come from env-defaults.json —
 * the single source of truth shared with env-shim.ts and dev-launcher.mjs.
 */
const ENV_DEFAULTS = require('./env-defaults.json')

for (const [key, value] of Object.entries(ENV_DEFAULTS)) {
  if (!key.startsWith('_') && !process.env[key]) process.env[key] = value
}

import('./out/main/index.js').catch((err) => {
  console.error('[bootstrap] Failed to load main process:', err)
  process.exit(1)
})
