/**
 * Host environment seams (ADR-21) — the only things host-core needs from the
 * shell. host-core itself never imports Electron; each shell supplies these:
 *
 *   - Electron main (desktop/src/main/electron-host.ts): real userData dirs,
 *     safeStorage (DPAPI) as the SecretStore, and webContents.send as the sink.
 *   - Android (Phase B, Kotlin + proot Node): filesDir as dataDir, decrypted
 *     Keystore values as an in-memory SecretStore, and the WS broadcast as the
 *     event sink.
 */

/** Filesystem roots the desktop app historically resolved via app.getPath(). */
export interface HostPaths {
  /** Per-user app data dir (was app.getPath('userData')). */
  dataDir: string
  /** Roaming app-data root (was app.getPath('appData')); used by the legacy migration only. */
  appDataDir: string
  /** Current user's home dir (was os.homedir()). */
  homeDir: string
}

/**
 * Secret storage seam. On desktop this wraps Electron safeStorage (DPAPI —
 * ADR-11). On Android it is an in-memory map hydrated once by the Kotlin shell
 * during the localhost handshake; values never touch disk or the WebView.
 *
 * Implementations are synchronous: safeStorage is sync and the Android
 * handshake decrypts before host-core starts.
 */
export interface SecretStore {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): { toString(encoding: 'base64'): string }
  decryptString(encoded: Uint8Array): string
}

/** Resolve an environment store lazily (set once by the shell before first use). */
export interface HostEnv {
  paths: HostPaths
  secrets: SecretStore
}

let env: HostEnv | null = null

/** Install the host environment. Must be called before any host-core module is used. */
export function installHostEnv(next: HostEnv): void {
  env = next
}

/** The installed environment (throws when the shell has not installed one). */
export function getHostEnv(): HostEnv {
  if (!env) {
    throw new Error(
      'host-core: no host environment installed. Call installHostEnv() from the shell before using host-core modules.',
    )
  }
  return env
}

export function hostPaths(): HostPaths {
  return getHostEnv().paths
}

export function hostSecrets(): SecretStore {
  return getHostEnv().secrets
}
