/**
 * GitHub skill download (skills plan D3 / P1).
 *
 * Two channels:
 *   listGithubSkills      → folder-level candidates (folders holding SKILL.md)
 *   downloadGithubSkill   → whole subfolder download → installSkillMulti
 *
 * Network surface is structurally whitelisted: every URL is built from the
 * two constants below plus owner/repo segments that already passed
 * `parseGithubRepo`'s strict regexes — user input can never steer a request
 * to another host (defense-in-depth check in ghFetch anyway, plan D3).
 *
 * Quotas (plan D3): ≤30 files, ≤200KB per file (readSkillFile's cap), ≤2MB
 * total — filtered on the tree's `size` BEFORE downloading, over-limit files
 * are skipped and reported as `warning`; the SKILL.md itself never gets
 * skipped (it fails hard instead). Rate-limit answers (403/429 with
 * x-ratelimit-remaining: 0) explain the 60/hr unauthenticated ceiling and the
 * token field that raises it to 5,000/hr (P2 `github-token` vault).
 *
 * Verified against the live API on 2026-10-03: `git/trees/HEAD?recursive=1`
 * resolves HEAD, `raw.githubusercontent.com/<o>/<r>/HEAD/<path>` serves file
 * bytes, and an explicit User-Agent header is accepted from host fetch.
 */

import { existsSync } from 'fs'
import { join } from 'path'
import { getGithubToken } from '../settings/settings'
import {
  extractSkillName,
  globalSkillRoots,
  installSkillMulti,
  isSafeRelPath,
  type MultiSkillFile,
} from './install-skill'
import { isValidSkillName, SKILL_FILE_NAME } from '@codebuff/common/constants/skills'

const API_BASE = 'https://api.github.com'
const RAW_BASE = 'https://raw.githubusercontent.com'
const ALLOWED_HOSTS = new Set(['api.github.com', 'raw.githubusercontent.com'])

export const GITHUB_MAX_FILES = 30
export const GITHUB_MAX_FILE_BYTES = 200 * 1024
export const GITHUB_MAX_TOTAL_BYTES = 2 * 1024 * 1024

/**
 * How many per-file skip reasons are quoted in the returned `warning`.
 * A repo-root install from a large repository would otherwise serialize
 * thousands of entries into one giant string (skills review #5); the count
 * of the rest is appended instead.
 */
const MAX_QUOTED_SKIPS = 5

const REQUEST_TIMEOUT_MS = 15_000

export interface GithubRepo {
  owner: string
  repo: string
}

export interface GithubSkillCandidate {
  /** Display name — last path segment (repository name for a root skill). */
  name: string
  /** Repo-relative folder path; '' = the repository root itself. */
  path: string
  fileCount: number
}

export type ListGithubSkillsResult =
  | { ok: true; skills: GithubSkillCandidate[]; warning?: string }
  | { ok: false; error: string }

export type DownloadGithubSkillResult =
  | { ok: true; name: string; path: string; warning?: string }
  | { ok: false; exists?: boolean; name?: string; error: string }

/**
 * Parse `owner/repo`, `github.com/owner/repo`, or a full https GitHub URL.
 * Any OTHER host is rejected by name — input never reaches the network.
 * Extra path segments (`/tree/main/skills/…`) are dropped: the first two
 * segments are the repository.
 */
export function parseGithubRepo(input: string): GithubRepo | { error: string } {
  let s = (input ?? '').trim()
  if (!s) return { error: 'Enter a repository as owner/repo (for example anthropics/skills).' }
  s = s.replace(/^https?:\/\//i, '')
  const hostMatch = s.match(/^([^/?#]+)\//)
  if (hostMatch && hostMatch[1].includes('.')) {
    const host = hostMatch[1].toLowerCase()
    if (host !== 'github.com' && host !== 'www.github.com') {
      return { error: `Only github.com repositories are supported (got "${hostMatch[1]}").` }
    }
    s = s.slice(hostMatch[0].length)
  }
  s = s.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '')
  const segs = s.split('/').filter((x) => x.length > 0)
  if (segs.length < 2) {
    return { error: 'Enter a repository as owner/repo (for example anthropics/skills).' }
  }
  const [owner, repo] = segs
  if (!/^[A-Za-z0-9-]{1,39}$/.test(owner)) return { error: `Invalid GitHub owner "${owner}".` }
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo)) return { error: `Invalid GitHub repository name "${repo}".` }
  return { owner, repo }
}

/** Shared fetch guard: whitelist + timeout + auth header + friendly errors. */
async function ghFetch(url: string): Promise<Response> {
  const host = new URL(url).host
  if (!ALLOWED_HOSTS.has(host)) throw new Error(`Refusing non-whitelisted host: ${host}`)
  const headers: Record<string, string> = { 'User-Agent': 'AnyBuff' }
  const token = getGithubToken()
  if (token) headers.Authorization = `Bearer ${token}`
  try {
    return await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') throw new Error('The GitHub request timed out.')
    throw new Error(`GitHub request failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Map a non-ok GitHub API response to an actionable message (R4). */
function ghApiError(res: Response, context: string): Error {
  if (res.status === 404) {
    return new Error(
      `Repository not found on GitHub — "${context}" (or it is private; set a GitHub token to access private repositories).`,
    )
  }
  if (res.status === 403 || res.status === 429) {
    if (res.headers.get('x-ratelimit-remaining') === '0') {
      return new Error(
        'GitHub API rate limit exceeded — unauthenticated requests allow 60 per hour. Set a GitHub token in this section to raise the limit to 5,000 per hour.',
      )
    }
    return new Error(`GitHub denied the request (${res.status}). Try again later, or set a GitHub token.`)
  }
  return new Error(`GitHub ${context} failed with status ${res.status}.`)
}

interface TreeEntry {
  path: string
  type: string
  size?: number
}

async function fetchTree(repo: GithubRepo): Promise<{ blobs: TreeEntry[]; truncated: boolean }> {
  const url = `${API_BASE}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/git/trees/HEAD?recursive=1`
  const res = await ghFetch(url)
  if (!res.ok) throw ghApiError(res, `repository "${repo.owner}/${repo.repo}"`)
  const json = (await res.json()) as { tree?: unknown; truncated?: unknown }
  if (!Array.isArray(json.tree)) throw new Error('Unexpected response from the GitHub trees API.')
  const blobs = (json.tree as TreeEntry[]).filter(
    (e): e is TreeEntry => Boolean(e) && typeof e.path === 'string' && e.type === 'blob',
  )
  return { blobs, truncated: Boolean(json.truncated) }
}

/** Download one file as raw bytes (raw.githubusercontent.com — not rate-limited). */
async function rawFetch(repo: GithubRepo, path: string): Promise<Buffer> {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')
  const url = `${RAW_BASE}/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/HEAD/${encodedPath}`
  const res = await ghFetch(url)
  if (!res.ok) {
    if (res.status === 404) throw new Error(`File not found in the repository: ${path}`)
    if (res.status === 403 || res.status === 429) {
      throw new Error(`GitHub denied access to ${path} (${res.status}) — private repository? Set a GitHub token.`)
    }
    throw new Error(`Download failed for ${path} (status ${res.status}).`)
  }
  return Buffer.from(await res.arrayBuffer())
}

/** AnyBuff:listGithubSkills — folders that directly contain SKILL.md. */
export async function listGithubSkills(input: { repo?: string }): Promise<ListGithubSkillsResult> {
  const parsed = parseGithubRepo(input?.repo ?? '')
  if ('error' in parsed) return { ok: false, error: parsed.error }
  try {
    const { blobs, truncated } = await fetchTree(parsed)

    const folders = new Set<string>()
    for (const b of blobs) {
      if (b.path === SKILL_FILE_NAME) folders.add('')
      else if (b.path.endsWith(`/${SKILL_FILE_NAME}`)) {
        folders.add(b.path.slice(0, b.path.length - SKILL_FILE_NAME.length - 1))
      }
    }
    const skills: GithubSkillCandidate[] = [...folders]
      .sort()
      .map((folder) => ({
        name: folder ? folder.split('/').pop()! : parsed.repo,
        path: folder,
        fileCount: blobs.filter((b) =>
          folder === ''
            ? true
            : b.path === `${folder}/${SKILL_FILE_NAME}` || b.path.startsWith(`${folder}/`),
        ).length,
      }))
    return {
      ok: true,
      skills,
      ...(truncated
        ? { warning: 'GitHub truncated this repository tree — some skills may be missing from the list.' }
        : {}),
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** AnyBuff:downloadGithubSkill — whole subfolder (SKILL.md + same-folder attachments). */
export async function downloadGithubSkill(input: {
  repo?: string
  path?: string
  confirm?: boolean
}): Promise<DownloadGithubSkillResult> {
  const parsed = parseGithubRepo(input?.repo ?? '')
  if ('error' in parsed) return { ok: false, error: parsed.error }
  const folder = input?.path ?? ''
  if (folder !== '' && !isSafeRelPath(folder)) {
    return { ok: false, error: `Invalid repository path: ${folder}` }
  }

  let blobs: TreeEntry[]
  let truncated: boolean
  try {
    ;({ blobs, truncated } = await fetchTree(parsed))
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  const prefix = folder === '' ? '' : `${folder}/`
  const inFolder = blobs.filter((b) => folder === '' || b.path.startsWith(prefix))
  const skillEntry = inFolder.find((b) => b.path === `${prefix}${SKILL_FILE_NAME}`)
  if (!skillEntry) {
    return { ok: false, error: `No ${SKILL_FILE_NAME} in "${folder || 'the repository root'}" of this repository.` }
  }

  // Quota pre-filter on the tree's size (download only what survives).
  // SKILL.md is processed first so the skill itself is never quota-skipped.
  const warnings: string[] = []
  const ordered = [skillEntry, ...inFolder.filter((b) => b !== skillEntry)]
  const accepted: TreeEntry[] = []
  let projected = 0
  for (const e of ordered) {
    const size = e.size ?? 0
    if (accepted.length >= GITHUB_MAX_FILES) {
      warnings.push(`"${e.path}" exceeds the ${GITHUB_MAX_FILES}-file limit`)
      continue
    }
    if (size > GITHUB_MAX_FILE_BYTES) {
      warnings.push(`"${e.path}" is larger than 200KB`)
      continue
    }
    if (projected + size > GITHUB_MAX_TOTAL_BYTES) {
      warnings.push(`"${e.path}" would exceed the 2MB total limit`)
      continue
    }
    accepted.push(e)
    projected += size
  }
  if (!accepted.includes(skillEntry)) {
    return { ok: false, error: `The skill's ${SKILL_FILE_NAME} exceeds the 200KB single-file install limit.` }
  }

  // SKILL.md first: it carries the frontmatter name the install keys on.
  let skillData: Buffer
  try {
    skillData = await rawFetch(parsed, skillEntry.path)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  if (skillData.byteLength > GITHUB_MAX_FILE_BYTES) {
    return { ok: false, error: `The skill's ${SKILL_FILE_NAME} exceeds the 200KB single-file install limit.` }
  }
  const skillText = skillData.toString('utf-8')
  const name = extractSkillName(skillText)
  if (!name) {
    return {
      ok: false,
      error: `No frontmatter name found in ${skillEntry.path} — this folder is not an installable skill.`,
    }
  }
  if (!isValidSkillName(name)) {
    return {
      ok: false,
      error: `Invalid skill name "${name}" in frontmatter: use 1-64 lowercase letters, digits, and single hyphens.`,
    }
  }

  // Early exists-confirm: a duplicate fails BEFORE the remaining files are
  // downloaded (bandwidth + rate-limit friendly). installSkillMulti re-checks
  // at write time — this is the fast path, not the only gate.
  const existing = join(globalSkillRoots()[0].dir, name, SKILL_FILE_NAME)
  if (existsSync(existing) && !input?.confirm) {
    return {
      ok: false,
      exists: true,
      // The FRONTMATTER name — the skill the overwrite will actually replace.
      // The folder tail / repo string can differ from it and is a poor label
      // for a confirm dialog (skills review #2).
      name,
      error: `A skill named "${name}" already exists at ${existing}. Confirm to overwrite it.`,
    }
  }

  const files: MultiSkillFile[] = [{ path: SKILL_FILE_NAME, data: skillData }]
  let downloaded = skillData.byteLength
  try {
    for (const e of accepted) {
      if (e === skillEntry) continue
      const data = await rawFetch(parsed, e.path) // a hard failure aborts: no half-skill
      // Post-download byte checks — tree `size` is advisory, bytes are truth.
      if (data.byteLength > GITHUB_MAX_FILE_BYTES) {
        warnings.push(`"${e.path}" is larger than 200KB`)
        continue
      }
      if (downloaded + data.byteLength > GITHUB_MAX_TOTAL_BYTES) {
        warnings.push(`"${e.path}" would exceed the 2MB total limit`)
        continue
      }
      downloaded += data.byteLength
      files.push({ path: e.path.slice(prefix.length), data })
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  const installed = installSkillMulti({ name, files, confirm: input?.confirm, source: 'github' })
  if (!installed.ok) return installed
  const quotedSkips = warnings.slice(0, MAX_QUOTED_SKIPS)
  const unquotedSkips = warnings.length - quotedSkips.length
  const warning = [
    ...(truncated ? ['repository tree was truncated by GitHub'] : []),
    ...(warnings.length > 0
      ? [
          `skipped ${quotedSkips.join('; ')}${
            unquotedSkips > 0 ? ` (and ${unquotedSkips} more skipped files)` : ''
          }`,
        ]
      : []),
  ].join(' — ')
  return { ok: true, name: installed.name, path: installed.path, ...(warning ? { warning } : {}) }
}
