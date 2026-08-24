/**
 * Packaged-app launch smoke test — the last step of `npm run dist`.
 *
 * Launches the freshly built win-unpacked exe and verifies the main process
 * survives startup without the import-time crashes that killed 0.1.0-beta.1
 * (common/env.ts "Invalid environment configuration", and any other uncaught
 * exception during module evaluation). Catches regressions in the bootstrap
 * entry chain (bootstrap.cjs -> out/main/index.js -> externalized SDK).
 *
 * Pass criteria: the process stays alive for GRACE_MS with no failure marker
 * in its output. (A visible app window appears briefly while this runs.)
 *
 * Exit codes: 0 = pass, 1 = fail.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const desktopRoot = join(scriptsDir, '..')

const GRACE_MS = 12_000
const EXE = join(desktopRoot, 'release-build', 'win-unpacked', 'AnyBuff.exe')

// Substrings in stdout/stderr that indicate an import-time crash. Electron
// prints the exception and dialog text to the console when the main process
// throws during module evaluation.
const FAILURE_MARKERS = [
  'Invalid environment configuration',
  'Environment validation failed',
  'Uncaught Exception',
  'Uncaught exception',
  '[bootstrap] Failed to load main process'
]

if (!existsSync(EXE)) {
  console.error(`[smoke] Packaged exe not found: ${EXE}`)
  console.error('[smoke] Run the full build first: npm run dist')
  process.exit(1)
}

console.log(`[smoke] Launching ${EXE} (a window will appear for ~${GRACE_MS / 1000}s)...`)

// Isolated throwaway userData: the instance acquires its own single-instance
// lock (main/index.ts honors ANYBUFF_SMOKE_USER_DATA) and never touches the
// user's real session data — so the smoke test can run while the installed
// app or a dev instance is open.
const smokeUserData = mkdtempSync(join(tmpdir(), 'anybuff-smoke-'))

const child = spawn(EXE, [], {
  stdio: ['ignore', 'pipe', 'pipe'],
  cwd: desktopRoot,
  env: { ...process.env, ANYBUFF_SMOKE_USER_DATA: smokeUserData }
})

let output = ''
const collect = (chunk) => {
  output += chunk.toString()
}
child.stdout.on('data', collect)
child.stderr.on('data', collect)

const killTree = () => {
  if (process.platform === 'win32') {
    // /T kills the whole process tree (GPU/utility children), /F forces.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    child.kill('SIGKILL')
  }
}

let exited = null
child.on('exit', (code, signal) => {
  exited = { code, signal }
})

const result = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve('grace-elapsed'), GRACE_MS)
  child.on('exit', () => {
    clearTimeout(timer)
    resolve('exited-early')
  })
})

killTree()

try {
  rmSync(smokeUserData, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
} catch {
  // Best effort — the OS temp cleaner will get it eventually.
}

const foundMarker = FAILURE_MARKERS.filter((m) => output.includes(m))

if (result === 'exited-early') {
  console.error('[smoke] FAIL: packaged app exited during startup.')
  console.error(
    '[smoke] Hint: the single-instance lock makes a second instance quit ' +
      'immediately — close any running dev instance / installed AnyBuff and retry.'
  )
  console.error('[smoke] ---- app output ----\n' + output)
  process.exit(1)
}

if (foundMarker.length > 0) {
  console.error(`[smoke] FAIL: startup failure marker(s) found: ${JSON.stringify(foundMarker)}`)
  console.error('[smoke] ---- app output ----\n' + output)
  process.exit(1)
}

console.log(`[smoke] PASS: app survived ${GRACE_MS / 1000}s of startup with no failure markers.`)
