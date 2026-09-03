import { mkdirSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync, unlinkSync, existsSync } from 'fs'
import { dirname } from 'path'

/**
 * PLAN.md §9.5 atomic-write spec (Desktop side; mirrors the SDK's
 * provider-config writer):
 *
 * 1. Unique temp file `{file}.{pid}.{ts}.tmp` in the SAME directory
 * 2. fsync before rename
 * 3. rename-replace directly — NEVER delete the target first
 *    (Windows fs.rename = MoveFileExW(REPLACE_EXISTING), atomic on NTFS)
 * 4. EPERM/EACCES/EBUSY get bounded backoff retries (AV/indexer locks)
 * 5. On total failure the OLD FILE IS PRESERVED and the error rethrown
 * 6. No copy fallback pretending to be atomic
 */

const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

function sleepSync(ms: number): void {
  if (ms <= 0) return
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    // Environments without a waitable main thread: fall through.
  }
}

function renameReplaceWithRetry(
  tempPath: string,
  filePath: string,
  attempts = 6,
): void {
  let delayMs = 50
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      renameSync(tempPath, filePath)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      const retryable =
        RENAME_RETRY_CODES.has(code) || code === 'EEXIST'
      if (!retryable || attempt === attempts - 1) {
        throw error
      }
      sleepSync(delayMs)
      delayMs *= 2
    }
  }
}

function fsyncFile(filePath: string): void {
  let fd: number | undefined
  try {
    fd = openSync(filePath, 'r+')
    fsyncSync(fd)
  } catch {
    // Best-effort durability on filesystems that reject fsync.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Atomically replace `filePath` with `content` per the §9.5 spec. On failure
 * the previous file remains intact and the error propagates to the caller.
 */
export function writeFileAtomic(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tempPath, content, 'utf-8')
  fsyncFile(tempPath)
  renameReplaceWithRetry(tempPath, filePath)
}
