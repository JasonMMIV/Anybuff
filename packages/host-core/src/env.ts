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
  /**
   * Plaintext provider keys hydrated by the shell (Android: decrypted from
   * Keystore during the localhost handshake; dev hosts: ANYBUFF_HOST_SECRETS).
   * These take precedence over disk-encrypted entries and live only in this
   * process's memory (ADR-12 — never written to env or disk by host-core).
   */
  keyOverrides?: Record<string, string>
  /**
   * Optional shell-backed secret persistence (Android: Kotlin writes the
   * Keystore and re-hydrates). When absent, saves fall through to the
   * SecretStore disk-encrypt path (which throws on a decrypt-only store).
   */
  keyPersistence?: {
    save(providerId: string, plain: string): void
    remove(providerId: string): void
  }
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

/** Overlay provider keys (empty when none installed or env not yet installed). */
export function hostKeyOverrides(): Record<string, string> {
  return env?.keyOverrides ?? {}
}

/** Shell-backed key persistence (undefined when the shell does not provide one). */
export function hostKeyPersistence(): HostEnv['keyPersistence'] {
  return env?.keyPersistence ?? undefined
}
