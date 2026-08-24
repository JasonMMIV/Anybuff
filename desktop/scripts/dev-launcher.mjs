/**
 * Dev launcher: sets import-time env defaults BEFORE electron-vite (and thus
 * the bundled main process importing @codebuff/sdk) boots. ESM evaluates
 * external dependencies before any module body runs, so an in-bundle shim
 * cannot satisfy common/env validation — it must exist in process.env up front.
 * Defaults come from env-defaults.json — the single source of truth shared
 * with bootstrap.cjs (packaged) and src/main/env-shim.ts.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const envDefaults = require('../env-defaults.json')

for (const [k, v] of Object.entries(envDefaults)) {
  if (!k.startsWith('_') && !process.env[k]) process.env[k] = v
}

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
