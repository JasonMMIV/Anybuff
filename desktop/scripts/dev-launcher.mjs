/**
 * Dev launcher: sets import-time env defaults BEFORE electron-vite (and thus
 * the bundled main process importing @codebuff/sdk) boots. ESM evaluates
 * external dependencies before any module body runs, so an in-bundle shim
 * cannot satisfy common/env validation — it must exist in process.env up front.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const defaults = {
  NEXT_PUBLIC_CB_ENVIRONMENT: 'test',
  NEXT_PUBLIC_CODEBUFF_APP_URL: 'http://localhost:3000',
  NEXT_PUBLIC_WEB_PORT: '3000',
  NEXT_PUBLIC_SUPPORT_EMAIL: 'support@anybuff.local',
  NEXT_PUBLIC_POSTHOG_API_KEY: 'disabled-posthog-key',
  NEXT_PUBLIC_POSTHOG_HOST_URL: 'https://us.i.posthog.com',
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_placeholder',
  NEXT_PUBLIC_STRIPE_CUSTOMER_PORTAL:
    'https://billing.stripe.com/p/login/test_placeholder'
}

for (const [k, v] of Object.entries(defaults)) {
  if (!process.env[k]) process.env[k] = v
}

const require = createRequire(import.meta.url)
const pkg = require('electron-vite/package.json')
const cli = join(dirname(require.resolve('electron-vite/package.json')), pkg.bin['electron-vite'] ?? 'dist/cli.js')

const args = process.argv.slice(2)
if (args.length === 0) args.push('dev')

const child = spawn(process.execPath, [cli, ...args], {
  stdio: 'inherit',
  env: process.env,
  cwd: join(import.meta.url.replace(/^file:\/\/\//, '').replace(/\/[^/]*$/, ''), '..')
})
child.on('exit', (code) => process.exit(code ?? 0))
