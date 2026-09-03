/**
 * Local smoke for the self-contained anybuff-host bundle (M-A3).
 * Spawns the host with a hydrated in-memory overlay key + wasm/rg paths,
 * then drives the WS envelope: getState (key overlay visible) + listProjects.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')

// Resolve from this script's location (packages/host-core/scripts/… → host-core root, → repo root).
const scriptDir = fileURLToPath(new URL('.', import.meta.url))
const hostCoreRoot = join(scriptDir, '..') // …/packages/host-core
const repoRoot = join(hostCoreRoot, '..', '..') // repo root
const dir = mkdtempSync(join(tmpdir(), 'anybuff-host-smoke-'))
const dataDir = join(dir, 'data')
const outLog = join(dir, 'out.log')

const host = spawn(
  process.execPath, // plain node — proves the bundle is self-contained
  [join(hostCoreRoot, 'dist/anybuff-host.mjs')],
  {
    env: {
      ...process.env,
      ANYBUFF_HOST_DATA_DIR: dataDir,
      ANYBUFF_HOST_PORT: '0',
      ANYBUFF_HOST_TOKEN: 'devtoken',
      ANYBUFF_HOST_SECRETS: JSON.stringify({ openai: 'sk-test-123' }),
      ANYBUFF_HOST_WASM_DIR: join(repoRoot, 'sdk/dist/wasm'),
      ANYBUFF_HOST_TS_WASM: join(repoRoot, 'sdk/dist/wasm/tree-sitter.wasm'),
      ANYBUFF_HOST_RG_PATH: join(repoRoot, 'sdk/dist/vendor/ripgrep/x64-win32/rg.exe'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)
let log = ''
host.stdout.on('data', (d) => (log += d.toString()))
host.stderr.on('data', (d) => (log += d.toString()))
host.on('exit', (code) => {
  log += `\n[host exited with code ${code}]\n`
})
writeFileSync(outLog, '')

const timeout = setTimeout(() => {
  console.error('TIMEOUT waiting for host')
  console.error(log)
  host.kill()
  process.exit(1)
}, 20000)

async function waitReady(): Promise<{ port: number; token: string }> {
  for (let i = 0; i < 40; i++) {
    const m = log.match(/ANYBUFF_HOST_READY (\d+) (\S+)/)
    if (m) return { port: Number(m[1]), token: m[2] }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('no READY line. log:\n' + log)
}

function retryConnect(
  port: number,
  token: string,
  attempts = 20,
): Promise<{ call: (ch: string, args: unknown[]) => Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const tryOnce = (left: number) => {
      connect(port, token)
        .then(resolve)
        .catch((e) => {
          if (left <= 0) return reject(e)
          setTimeout(() => tryOnce(left - 1), 300)
        })
    }
    tryOnce(attempts)
  })
}

function connect(port: number, token: string): Promise<{ call: (ch: string, args: unknown[]) => Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${token}`)
    let seq = 0
    const pending = new Map<number, { resolve: (v: unknown) => void }>()
    ws.on('open', () => {
      resolve({
        call: (ch, args) =>
          new Promise((res) => {
            const id = ++seq
            pending.set(id, { resolve: res })
            ws.send(JSON.stringify({ id, channel: ch, args }))
          }),
      })
    })
    ws.on('error', reject)
    ws.on('message', (raw: Buffer) => {
      const msg = JSON.parse(raw.toString())
      const p = pending.get(msg.id)
      if (p) {
        pending.delete(msg.id)
        p.resolve(msg.ok ? msg.result : { ok: false, error: msg.error })
      }
    })
  })
}

async function main() {
  const { port, token } = await waitReady()
  console.log('READY', port, token)
  const client = await retryConnect(port, token)

  const state = (await client.call('getState', [])) as {
    settings?: { providerHasKey?: Record<string, boolean>; hasProvider?: boolean }
  }
  const s = state.settings ?? {}
  console.log('getState.settings.providerHasKey =', JSON.stringify(s.providerHasKey))
  if (!s.providerHasKey?.openai) throw new Error('FAIL: hydrated overlay key not visible in providerHasKey')

  const projects = (await client.call('listProjects', [])) as unknown
  console.log('listProjects isArray =', Array.isArray(projects))
  if (!Array.isArray(projects)) throw new Error('FAIL: listProjects not an array')

  console.log('SMOKE PASS')
}

main()
  .catch((e) => {
    console.error('SMOKE FAIL:', e.message)
    console.error('--- host log ---\n' + log)
    process.exitCode = 1
  })
  .finally(() => {
    clearTimeout(timeout)
    host.kill()
    rmSync(dir, { recursive: true, force: true })
  })
