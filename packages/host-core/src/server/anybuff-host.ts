#!/usr/bin/env node
/**
 * anybuff-host — standalone headless host entry point (M-A3 / Phase B).
 *
 * The same @codebuff/host-core business logic the Electron desktop uses,
 * served over WebSocket loopback for the Android sandbox Node 22 runtime
 * (proot Ubuntu, Phase B Kotlin shell spawns this) and for the
 * browser-preview dev flow on desktop.
 *
 * Configuration (all via environment — no argv parsing, no interactive input):
 *
 *   ANYBUFF_HOST_DATA_DIR   Per-user data dir (hostPaths.dataDir).
 *                           Required.
 *   ANYBUFF_HOST_APPDATA    Roaming app-data root (hostPaths.appDataDir,
 *                           legacy migration only). Defaults to dataDir.
 *   ANYBUFF_HOST_HOME       Guest home dir (hostPaths.homeDir).
 *                           Defaults to $HOME / dataDir.
 *   ANYBUFF_HOST_PORT       Loopback port (0 = dynamic, default).
 *   ANYBUFF_HOST_TOKEN      Bearer token. Default: random per boot (printed
 *                           on stdout as ANYBUFF_HOST_READY). Pin it in dev
 *                           for a stable ?ws= URL.
 *   ANYBUFF_HOST_ORIGINS    Comma-separated Origin allowlist. Default:
 *                           defaultAllowedOrigins() (dev/preview localhost
 *                           origins). The Android shell passes
 *                           https://appassets.androidplatform.net.
 *   ANYBUFF_HOST_SECRETS    JSON map { providerId: plaintextApiKey } for the
 *                           one-shot Keystore-backed in-memory hydration
 *                           (Phase B M-B2). Values never touch disk: they live
 *                           only in this process's memory as the keyOverrides
 *                           overlay and reach the SDK via the per-run
 *                           apiKeyOverrides channel (ADR-12). Empty/absent =
 *                           no hydrated keys (keys must then be entered in UI).   *   ANYBUFF_HOST_RG_PATH    Path to the ripgrep binary (CODEBUFF_RG_PATH for
   *                           the bundled SDK). Android expands the asset-copied
   *                           arm64 rg into filesDir and passes it here.
   *   ANYBUFF_HOST_WASM_DIR   Directory containing the per-language tree-sitter
   *                           *.wasm files (CODEBUFF_WASM_DIR for the bundled
   *                           SDK). Android expands the app-bundled wasm set
   *                           into filesDir.
   *   ANYBUFF_HOST_TS_WASM    Absolute path to the core tree-sitter.wasm runtime
   *                           (CODEBUFF_TREE_SITTER_WASM_PATH for the bundled
   *                           SDK). Falls back to a sibling tree-sitter.wasm
   *                           next to the host file when unset.
 *   ANYBUFF_PROVIDER_CONFIG Passed through to the SDK provider-config path
 *                           when preset (normally host-core writes it per run
 *                           into the data dir — leave unset on Android).
 *
 * Startup contract (parsed by the Kotlin shell):
 *   - Prints exactly one `ANYBUFF_HOST_READY <port> <token>` line on stdout
 *     once the WS server is listening.
 *   - Stays in the foreground until killed (the shell owns lifecycle/FGS).
 *   - Any fatal error exits non-zero before printing the ready line.
 *
 * Security posture mirrors desktop: loopback-only bind, per-boot token,
 * Origin allowlist. Keys never enter process.env (ADR-12).
 */

import { installHostEnv } from '../env'
import { createEventBus } from '../events'
import { createHost } from '../channels/dispatcher'
import { startWsHost, defaultAllowedOrigins } from './ws-server'

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`[anybuff-host] missing required env: ${name}`)
    process.exit(2)
  }
  return value
}

/** A SecretStore whose reads all fail: host-side encryption is refused so
 * hydrated keys can never be persisted in reversible form (ADR-11) — the
 * Kotlin shell is the only encryptor (Keystore). */
function noDiskSecrets() {
  return {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error(
        'credential encryption unavailable on the headless host: keys arrive via ANYBUFF_HOST_SECRETS and live in memory only (ADR-11/12)',
      )
    },
    decryptString: () => {
      throw new Error('no disk-encrypted secrets on the headless host')
    },
  }
}

async function main(): Promise<void> {
  const dataDir = required('ANYBUFF_HOST_DATA_DIR')
  const appDataDir = process.env.ANYBUFF_HOST_APPDATA ?? dataDir
  const homeDir = process.env.ANYBUFF_HOST_HOME ?? process.env.HOME ?? dataDir

  const keyOverrides: Record<string, string> = {}
  const raw = process.env.ANYBUFF_HOST_SECRETS
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'string' && v) keyOverrides[k] = v
        }
      }
    } catch (error) {
      console.error('[anybuff-host] ANYBUFF_HOST_SECRETS is not valid JSON — starting without hydrated secrets')
    }
  }
  // The handshake material must not linger in the environment (ADR-12).
  delete process.env.ANYBUFF_HOST_SECRETS

  // Point the bundled SDK at the shell-expanded native assets (Android
  // proot): the dist-relative vendored fallback cannot exist there.
  const rgPath = process.env.ANYBUFF_HOST_RG_PATH
  if (rgPath) process.env.CODEBUFF_RG_PATH = rgPath
  const wasmDir = process.env.ANYBUFF_HOST_WASM_DIR
  if (wasmDir) process.env.CODEBUFF_WASM_DIR = wasmDir
  const tsWasm = process.env.ANYBUFF_HOST_TS_WASM
  if (tsWasm) process.env.CODEBUFF_TREE_SITTER_WASM_PATH = tsWasm

  installHostEnv({
    paths: { dataDir, appDataDir, homeDir },
    secrets: noDiskSecrets(),
    keyOverrides,
  })

  const bus = createEventBus()
  const host = createHost({ eventBus: bus })

  const port = Number(process.env.ANYBUFF_HOST_PORT ?? '0') || 0
  const token = process.env.ANYBUFF_HOST_TOKEN || undefined
  const originsRaw = process.env.ANYBUFF_HOST_ORIGINS
  const allowedOrigins =
    originsRaw !== undefined
      ? originsRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : defaultAllowedOrigins()

  const wsHost = await startWsHost({ host, eventBus: bus, port, token, allowedOrigins })

  // Single machine-readable ready line consumed by the Kotlin shell.
  console.log(`ANYBUFF_HOST_READY ${wsHost.port} ${wsHost.token}`)

  const shutdown = (): void => {
    void wsHost.close().finally(() => process.exit(0))
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((error) => {
  console.error('[anybuff-host] fatal:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
