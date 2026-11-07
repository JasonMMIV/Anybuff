import { execFile } from 'child_process'
import { realpath } from 'fs/promises'
import { resolve } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
/** cwd → canonical key. Avoids a git subprocess per run/accept/revert click. */
const projectKeyCache = new Map<string, string>()

/**
 * Canonical identity of "the same working tree".
 *
 * A run lock keyed by the raw cwd is not enough: a monorepo can be opened from
 * two different subdirectories, a Windows junction/symlink can point at the
 * same checkout, and Windows paths are case-insensitive. Any of those would
 * make the "one run per project" rule bypassable and allow two runs to edit
 * the same files concurrently.
 *
 * Resolution order:
 *   1. realpath(cwd) — resolves symlinks/junctions;
 *   2. git rev-parse --show-toplevel — collapses monorepo subdirectories;
 *   3. lower-case on Windows (case-insensitive filesystem).
 *
 * Missing directories and non-git projects fall back to the realpath of cwd.
 */
export async function resolveProjectKey(cwd: string): Promise<string> {
  const requested = resolve(cwd)
  const cacheKey = process.platform === 'win32' ? requested.toLowerCase() : requested
  const cached = projectKeyCache.get(cacheKey)
  if (cached) return cached

  let canonical = requested
  try {
    canonical = await realpath(canonical)
  } catch {
    // The folder may not exist yet (or is a virtual path); resolve() is the
    // best stable identity available and still distinguishes projects.
  }

  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: canonical,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    })
    const top = stdout.trim()
    if (top) {
      canonical = await realpath(top).catch(() => resolve(top))
    }
  } catch {
    // Not a git repository (or git is unavailable) — the directory is the
    // project boundary.
  }

  const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical
  projectKeyCache.set(cacheKey, key)
  return key
}

/** Test seam for suites that recreate a directory as a different worktree. */
export function __resetProjectKeyCacheForTests(): void {
  projectKeyCache.clear()
}
