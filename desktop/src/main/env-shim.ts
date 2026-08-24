/**
 * Import-time environment defaults for the Electron main process.
 *
 * MUST be the first import of the main entry: @codebuff/sdk's bundled
 * common/env validates web-era variables the moment any contract module is
 * evaluated. Local BYOK ships no web backend, so we satisfy the schema with
 * inert placeholders instead of patching upstream (keeps git merges clean).
 *
 * NOTE: because @codebuff/sdk is externalized, ESM evaluates it BEFORE this
 * module body — this shim alone cannot satisfy the validation. It is kept as
 * belt-and-suspenders; the real guarantee is the raw-CJS bootstrap.cjs entry
 * (packaged) and scripts/dev-launcher.mjs (dev). Defaults live in
 * env-defaults.json — the single source of truth shared by all three.
 */
import envDefaults from '../../env-defaults.json'

for (const [key, value] of Object.entries(envDefaults)) {
  if (!key.startsWith('_') && !process.env[key]) process.env[key] = value
}

export {}
