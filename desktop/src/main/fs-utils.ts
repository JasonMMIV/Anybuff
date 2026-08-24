import { execFile } from 'child_process'
import { readdirSync, readFileSync, statSync, existsSync, rmSync, type Dirent } from 'fs'
import { basename, join, relative, resolve, isAbsolute } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface TreeNode {
  name: string
  path: string
  type: 'file' | 'dir'
  children?: TreeNode[]
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '.freebuff', '__pycache__'])
const SKIP_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', '.DS_Store'])

/**
 * List a single directory's immediate children (lazy tree loading).
 * Gitignored files are intentionally shown (matching the agent's ability to
 * read them via read_files); only heavy/noise directories are excluded.
 */
export function listDir(root: string): TreeNode[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const nodes: TreeNode[] = []
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name) || SKIP_FILES.has(entry.name)) continue
    if (entry.name.startsWith('.')) continue
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      nodes.push({ name: entry.name, path: full, type: 'dir' })
    } else if (entry.isFile()) {
      nodes.push({ name: entry.name, path: full, type: 'file' })
    }
  }
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return nodes
}

/** Recursive listing (used for @-folder attachment expansion). */
export function listFiles(root: string, depth = 0): TreeNode[] {
  const nodes = listDir(root)
  if (depth >= 8) return nodes
  for (const node of nodes) {
    if (node.type === 'dir') {
      node.children = listFiles(node.path, depth + 1)
    }
  }
  return nodes
}

export function readProjectFile(path: string): { ok: boolean; content?: string; error?: string } {
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > 1024 * 1024) {
      return { ok: false, error: 'Not a file or larger than 1MB' }
    }
    const buffer = readFileSync(path)
    // Binary check heuristic: inspect the first 512 bytes for null byte (\x00)
    const checkLen = Math.min(buffer.length, 512)
    for (let i = 0; i < checkLen; i++) {
      if (buffer[i] === 0) {
        return { ok: false, error: 'Binary file cannot be previewed as text' }
      }
    }
    return { ok: true, content: buffer.toString('utf-8') }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 })
    return stdout.trim()
  } catch {
    return ''
  }
}

export async function getGitBranch(cwd: string): Promise<string> {
  const branch = await runGit(cwd, ['branch', '--show-current'])
  return branch || ''
}

export async function getGitStatus(cwd: string): Promise<string> {
  const status = await runGit(cwd, ['status', '--short'])
  return status
}

export async function getGitDiff(cwd: string): Promise<{ diff: string; files: string[] }> {
  const stat = await runGit(cwd, ['diff', '--stat'])
  const files = stat
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith(' '))
    .map((l) => l.split('|')[0].trim())
    .filter(Boolean)
  const full = await runGit(cwd, ['diff', '--no-color'])
  return { diff: full, files }
}

function isSafeSubpath(cwd: string, file: string): { safe: boolean; resolvedPath: string; rel: string } {
  const resolvedCwd = resolve(cwd)
  const resolvedPath = resolve(cwd, file)
  const rel = relative(resolvedCwd, resolvedPath)
  // rel is empty string if resolvedPath === resolvedCwd
  // rel is absolute if on different drives (Windows)
  const isInside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  return {
    safe: isInside,
    resolvedPath,
    rel
  }
}

/** Stage a single file so its change is "accepted" into the index. */
export async function gitAcceptFile(cwd: string, file: string): Promise<{ ok: boolean; error?: string }> {
  const check = isSafeSubpath(cwd, file)
  if (!check.safe) {
    return { ok: false, error: 'Invalid file path: path must be inside the project folder' }
  }
  try {
    await execFileAsync('git', ['add', '--', check.rel], { cwd })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Discard working-tree changes for a single file. */
export async function gitRevertFile(cwd: string, file: string): Promise<{ ok: boolean; error?: string }> {
  const check = isSafeSubpath(cwd, file)
  if (!check.safe) {
    return { ok: false, error: 'Invalid file path: path must be inside the project folder' }
  }
  try {
    await execFileAsync('git', ['checkout', '--', check.rel], { cwd })
    return { ok: true }
  } catch (err) {
    // Untracked files (created during the run) can't be checked out — delete them instead.
    // Verify it really is untracked and within cwd before removing anything.
    try {
      await execFileAsync('git', ['ls-files', '--error-unmatch', '--', check.rel], { cwd })
    } catch {
      if (existsSync(check.resolvedPath) && check.safe) {
        rmSync(check.resolvedPath, { force: true })
        return { ok: true }
      }
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function projectName(cwd: string): string {
  return basename(cwd) || cwd
}
