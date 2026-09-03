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
import { statSync } from 'fs'
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
