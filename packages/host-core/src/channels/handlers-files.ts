/**
 * File-system & git handlers (AnyBuff:listFiles / listDir / readFile /
 * pathInfo / gitBranch / gitDiff / gitAccept / gitRevert / projectName).
 *
 * Ported verbatim from the Electron shell's registerIpc().
 */

import {
  listFiles as listFilesFn,
  listDir as listDirFn,
  readProjectFile,
  getGitBranch as getGitBranchFn,
  getGitDiff as getGitDiffFn,
  gitAcceptFile,
  gitRevertFile,
  projectName as projectNameFn,
} from '../files/fs-utils'
import { readFileSync, statSync } from 'fs'
import { basename } from 'path'

/** AnyBuff:listFiles */
export function listFiles(root: string): unknown {
  return listFilesFn(root)
}

/** AnyBuff:listDir */
export function listDir(dir: string): unknown {
  return listDirFn(dir)
}

/** AnyBuff:readFile */
export function readFile(path: string): unknown {
  return readProjectFile(path)
}

/** Extensions treated as previewable images (served as base64 data URLs). */
const IMAGE_EXTENSIONS: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  svg: 'image/svg+xml',
}

/** Gap #14 preview limits — text raised to 4MB, images up to 8MB. */
const MAX_TEXT_BYTES = 4 * 1024 * 1024
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

export interface ReadFileDataResult {
  ok: boolean
  error?: string
  /** Machine-readable failure category (friendly UI copy lives in the renderer). */
  code?: 'too-large' | 'binary' | 'missing' | 'not-a-file'
  size?: number
  kind?: 'text' | 'image'
  mime?: string
  /** utf-8 content when kind === 'text'. */
  text?: string
  /** raw base64 (no data: prefix) when kind === 'image'. */
  base64?: string
}

/**
 * AnyBuff:readFileData — preview-oriented read (floating file preview, gap
 * #14). Text files return utf-8 (≤ 4MB); known image extensions return base64
 * (≤ 8MB, rendered as a data URL by the renderer). Unknown binaries are
 * rejected with a 'binary' code so the UI can point at the file actions.
 */
export function readFileData(path: string): ReadFileDataResult {
  let stat
  try {
    stat = statSync(path)
  } catch {
    return { ok: false, error: 'File does not exist', code: 'missing' }
  }
  if (!stat.isFile()) return { ok: false, error: 'Not a file', code: 'not-a-file' }

  const size = stat.size
  const ext = basename(path).split('.').pop()?.toLowerCase() ?? ''
  const imageMime = IMAGE_EXTENSIONS[ext]
  const maxBytes = imageMime ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES
  if (size > maxBytes) {
    const limitMb = Math.round(maxBytes / 1024 / 1024)
    return { ok: false, error: `File is larger than ${limitMb} MB`, code: 'too-large', size }
  }

  const buffer = readFileSync(path)
  if (imageMime) {
    return { ok: true, kind: 'image', mime: imageMime, size, base64: buffer.toString('base64') }
  }

  // Binary check heuristic: a null byte within the first 512 bytes.
  const checkLen = Math.min(buffer.length, 512)
  for (let i = 0; i < checkLen; i++) {
    if (buffer[i] === 0) {
      return { ok: false, error: 'Binary file cannot be previewed as text', code: 'binary', size }
    }
  }
  return { ok: true, kind: 'text', mime: 'text/plain', size, text: buffer.toString('utf-8') }
}

/** AnyBuff:pathInfo */
export function pathInfo(path: string): unknown {
  try {
    const stat = statSync(path)
    return { ok: true, isDir: stat.isDirectory(), name: basename(path) }
  } catch {
    return { ok: false, error: 'Path does not exist' }
  }
}

/** AnyBuff:gitBranch */
export async function gitBranch(cwd: string): Promise<unknown> {
  return await getGitBranchFn(cwd)
}

/** AnyBuff:gitDiff */
export async function gitDiff(cwd: string): Promise<unknown> {
  return await getGitDiffFn(cwd)
}

/** AnyBuff:gitAccept */
export async function gitAccept(payload: { cwd: string; file: string }): Promise<unknown> {
  return await gitAcceptFile(payload.cwd, payload.file)
}

/** AnyBuff:gitRevert */
export async function gitRevert(payload: { cwd: string; file: string }): Promise<unknown> {
  return await gitRevertFile(payload.cwd, payload.file)
}

/** AnyBuff:projectName */
export function projectName(cwd: string): unknown {
  return projectNameFn(cwd)
}
