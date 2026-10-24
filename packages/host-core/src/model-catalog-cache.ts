/**
 * ADR-31: install the models.dev disk-cache seam for the shared host.
 *
 * The SDK owns parsing/indexing/lookup and never knows a data directory; the
 * shell does. Both real shells (Electron desktop, Android proot Node) go
 * through `installHostEnv()`, so wiring it there gives both the same cache
 * without any per-shell code.
 *
 * The cache file holds only the projected public catalog (no user data, no
 * keys) and is written with the ADR-13 atomic writer.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { configureModelCatalogCache } from '@codebuff/sdk'

import { hostPaths } from './env'
import { writeFileAtomic } from './files/atomic-write'

const MODEL_CATALOG_CACHE_FILE = 'model-catalog-cache.json'

export function modelCatalogCachePath(): string {
  return join(hostPaths().dataDir, MODEL_CATALOG_CACHE_FILE)
}

let installedFor: string | undefined

/**
 * Register the disk cache with the SDK. Idempotent per data directory: a
 * second call for the same host is a no-op (the SDK keeps the warm index).
 */
export function installModelCatalogCache(): void {
  const path = modelCatalogCachePath()
  if (installedFor === path) return
  installedFor = path
  configureModelCatalogCache({
    load: () => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        // Missing/corrupt/unreadable cache simply leaves the snapshot in place.
        return null
      }
    },
    save: (json: string) => {
      writeFileAtomic(path, json)
    },
  })
}

/** Test seam: forget the installed path so a fresh host can re-register. */
export function resetModelCatalogCacheInstallForTest(): void {
  installedFor = undefined
}
