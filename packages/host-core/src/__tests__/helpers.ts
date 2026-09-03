/**
 * Shared helpers for host-core contract tests — temp HostEnv per test file.
 */

import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export interface TestEnv {
  dataDir: string
  /** Path of the persisted anybuff.json written by settings. */
  cleanup(): void
}

export function makeTestEnv(): TestEnv {
  const dataDir = mkdtempSync(join(tmpdir(), 'host-core-test-'))
  process.env.ANYBUFF_PROVIDER_CONFIG = join(dataDir, 'anybuff.json')
  return {
    dataDir,
    cleanup: () => {
      try {
        require('fs').rmSync(dataDir, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    },
  }
}

/** A SecretStore whose encryption is unavailable (mirrors headless/Android). */
export function noEncryptionSecrets() {
  return {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('encryption unavailable in test env')
    },
    decryptString: (_encoded: Uint8Array) => {
      throw new Error('encryption unavailable in test env')
    },
  }
}
