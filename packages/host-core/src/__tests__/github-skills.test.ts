/**
 * GitHub skill download (skills plan D3 / P1) + P2 provenance & token.
 *
 * Locks:
 *   1. parseGithubRepo — owner/repo variants accepted; any OTHER host is
 *      rejected by name before a request can be made (whitelist starts at
 *      input parsing; ghFetch re-checks defensively).
 *   2. listGithubSkills — folder-level SKILL.md collection (incl. a root
 *      skill), fileCount, truncated-tree warning, rate-limit message, and
 *      the P2 token going out as an Authorization header.
 *   3. downloadGithubSkill — whole-subfolder install with binary files
 *      intact, quota pre/post filters reported as `warning`, exists→confirm
 *      through dispatch (failure envelope keeps `exists`), traversal refusal,
 *      and atomicity (a failed download leaves neither the skill folder nor
 *      temp dirs behind).
 *   4. Provenance — installSkillMulti stamps metadata.source: github and the
 *      list surfaces it as SkillInfo.provenance.
 *   5. Token plumbing — saveGithubToken/getGithubToken round-trip,
 *      githubTokenSet in getState, saveSettings payload save/delete order.
 *
 * globalThis.fetch is stubbed for the whole file — no test ever hits the
 * network; a stray fetch without a handler fails loudly.
 */

import { describe, test, expect, afterAll } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { installHostEnv } from '../env'
import { createHost } from '../index'
import {
  downloadGithubSkill,
  listGithubSkills,
  parseGithubRepo,
} from '../skills/github-skills'
import { saveGithubToken } from '../settings/settings'

const dataDir = mkdtempSync(join(tmpdir(), 'host-core-gh-'))
const homeDir = mkdtempSync(join(tmpdir(), 'host-core-gh-home-'))
process.env.ANYBUFF_PROVIDER_CONFIG = join(dataDir, 'anybuff.json')

const agentsRoot = join(homeDir, '.agents', 'skills')

/** SecretStore with working "encryption" (identity) — needed for the token vault. */
function encryptionSecrets() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, 'utf-8'),
    decryptString: (b: Uint8Array) => Buffer.from(b).toString('utf-8'),
  }
}

function install(): void {
  installHostEnv({
    paths: { dataDir, appDataDir: dataDir, homeDir },
    secrets: encryptionSecrets(),
  })
}

/* ─── fetch stub ─────────────────────────────────────────────────────── */

type FetchHandler = (url: string, init?: RequestInit) => Response

let fetchHandler: FetchHandler | null = null
let fetchedUrls: string[] = []
const realFetch = globalThis.fetch

globalThis.fetch = ((input: unknown, init?: RequestInit) => {
  if (!fetchHandler) throw new Error('fetch called with no handler installed — test leak?')
  return fetchHandler(String(input), init)
}) as unknown as typeof globalThis.fetch

afterAll(() => {
  globalThis.fetch = realFetch
  for (const dir of [dataDir, homeDir]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
})

/** Route helper: trees API vs raw downloads, with a call log. */
function route(opts: {
  tree?: Array<{ path: string; size?: number; type?: string }>
  truncated?: boolean
  files?: Record<string, Uint8Array | string>
  /** Status override per raw path (default 200 when the file exists). */
  rawStatus?: Record<string, number>
}): void {
  fetchedUrls = []
  fetchHandler = (url, init) => {
    fetchedUrls.push(url)
    if (url.includes('api.github.com')) {
      return new Response(
        JSON.stringify({
          tree: (opts.tree ?? []).map((e) => ({
            path: e.path,
            type: e.type ?? 'blob',
            size: e.size ?? 10,
          })),
          truncated: Boolean(opts.truncated),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.includes('raw.githubusercontent.com')) {
      // URL: https://raw.githubusercontent.com/<owner>/<repo>/HEAD/<path...>
      const path = url.split('/HEAD/')[1] ?? ''
      const status = opts.rawStatus?.[path]
      if (status !== undefined) return new Response('boom', { status })
      const content = opts.files?.[decodeURIComponent(path)]
      if (content === undefined) return new Response('not found', { status: 404 })
      return new Response(content, { status: 200 })
    }
    throw new Error(`non-whitelisted URL requested: ${url}`)
  }
}

function noNetwork(): void {
  fetchedUrls = []
  fetchHandler = () => {
    throw new Error('network must not be touched by this test')
  }
}

const SKILL_MD = `---\nname: demo-skill\ndescription: A demo skill for tests.\n---\n\n# Demo\n`
const ROOT_SKILL_MD = `---\nname: root-skill\ndescription: A repo-root skill.\n---\n\nRoot body.\n`

function downloadPayload(overrides: Record<string, unknown> = {}) {
  return { repo: 'acme/widgets', path: 'skills/demo', ...overrides }
}

async function dispatchResult(channel: string, payload: unknown): Promise<Record<string, unknown>> {
  install()
  const host = createHost()
  return (await host.dispatch(channel as never, [payload] as never)) as Record<string, unknown>
}

/* ─── 1. parseGithubRepo ─────────────────────────────────────────────── */

describe('parseGithubRepo (input whitelist)', () => {
  test('accepts owner/repo, github.com URLs, .git suffix and subpaths', () => {
    expect(parseGithubRepo('anthropics/skills')).toEqual({ owner: 'anthropics', repo: 'skills' })
    expect(parseGithubRepo('github.com/anthropics/skills')).toEqual({ owner: 'anthropics', repo: 'skills' })
    expect(parseGithubRepo('https://github.com/anthropics/skills/')).toEqual({
      owner: 'anthropics',
      repo: 'skills',
    })
    expect(parseGithubRepo('https://github.com/anthropics/skills.git/')).toEqual({
      owner: 'anthropics',
      repo: 'skills',
    })
    // /tree/<ref>/... subpaths collapse to the first two segments.
    expect(parseGithubRepo('github.com/anthropics/skills/tree/main/skills/pdf')).toEqual({
      owner: 'anthropics',
      repo: 'skills',
    })
  })

  test('rejects any other host by name — no request can be attempted', () => {
    for (const bad of ['evil.com/a/b', 'https://gitlab.com/a/b', 'github.com.evil.tld/a/b']) {
      const res = parseGithubRepo(bad)
      expect('error' in res).toBe(true)
      if ('error' in res) expect(res.error).toContain('github.com')
    }
  })

  test('rejects empty / single-segment / malformed input', () => {
    for (const bad of ['', '   ', 'skills', 'C:\\users\\x']) {
      expect('error' in parseGithubRepo(bad)).toBe(true)
    }
    expect('error' in parseGithubRepo('BAD OWNER/other')).toBe(true)
  })
})

/* ─── 2. listGithubSkills ────────────────────────────────────────────── */

describe('listGithubSkills', () => {
  test('collects folders holding SKILL.md (incl. repo root) with fileCount', async () => {
    install()
    route({
      tree: [
        { path: 'SKILL.md', size: 100 },
        { path: 'README.md', size: 50 },
        { path: 'skills/foo/SKILL.md', size: 100 },
        { path: 'skills/foo/reference.md', size: 20 },
        { path: 'skills/bar/SKILL.md', size: 80 },
        { path: 'not-a-skill/notes.md', size: 10 },
      ],
    })
    const res = await listGithubSkills({ repo: 'acme/widgets' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.skills).toEqual([
      { name: 'widgets', path: '', fileCount: 6 }, // root skill = the whole repo is the unit
      { name: 'bar', path: 'skills/bar', fileCount: 1 },
      { name: 'foo', path: 'skills/foo', fileCount: 2 },
    ])
    expect(fetchedUrls).toHaveLength(1)
    expect(fetchedUrls[0]).toBe('https://api.github.com/repos/acme/widgets/git/trees/HEAD?recursive=1')
  })

  test('non-github input never reaches fetch', async () => {
    install()
    noNetwork()
    const res = await listGithubSkills({ repo: 'evil.com/a/b' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('github.com')
    expect(fetchedUrls).toHaveLength(0)
  })

  test('truncated tree surfaces a warning', async () => {
    install()
    route({ tree: [{ path: 'skills/a/SKILL.md' }], truncated: true })
    const res = await listGithubSkills({ repo: 'acme/widgets' })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.warning).toContain('truncated')
  })

  test('rate-limit answers explain 60/hr and the token (R4)', async () => {
    install()
    fetchedUrls = []
    fetchHandler = () =>
      new Response('{"message":"API rate limit exceeded"}', {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0' },
      })
    const res = await listGithubSkills({ repo: 'acme/widgets' })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toContain('60 per hour')
      expect(res.error).toContain('token')
    }
  })

  test('a stored token goes out as Authorization (P2 vault)', async () => {
    install()
    let captured: string | undefined
    const serveTree = () => {
      fetchHandler = (_url, init) => {
        captured = (init?.headers as Record<string, string> | undefined)?.Authorization
        return new Response(JSON.stringify({ tree: [] }), { status: 200 })
      }
    }
    try {
      saveGithubToken('tok-abc')
      serveTree()
      expect((await listGithubSkills({ repo: 'acme/widgets' })).ok).toBe(true)
      expect(captured).toBe('Bearer tok-abc')

      // Cleared → no header.
      saveGithubToken('')
      captured = undefined
      serveTree()
      expect((await listGithubSkills({ repo: 'acme/widgets' })).ok).toBe(true)
      expect(captured).toBeUndefined()
    } finally {
      saveGithubToken('')
    }
  })
})

/* ─── 3. downloadGithubSkill ─────────────────────────────────────────── */

describe('downloadGithubSkill', () => {
  test('installs the whole subfolder atomically — binary bytes intact, provenance stamped', async () => {
    const binary = new Uint8Array([0, 1, 2, 127, 128, 200, 255])
    route({
      tree: [
        { path: 'skills/demo/SKILL.md', size: SKILL_MD.length },
        { path: 'skills/demo/references/extra.md', size: 30 },
        { path: 'skills/demo/assets/logo.bin', size: binary.length },
      ],
      files: {
        'skills/demo/SKILL.md': SKILL_MD,
        'skills/demo/references/extra.md': 'extra content',
        'skills/demo/assets/logo.bin': binary,
      },
    })
    const res = await dispatchResult('downloadGithubSkill', downloadPayload())
    expect(res.ok).toBe(true)
    expect(res.name).toBe('demo-skill')

    const dir = join(agentsRoot, 'demo-skill')
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf-8')).toContain(SKILL_MD.split('\n')[1])
    expect(readFileSync(join(dir, 'references', 'extra.md'), 'utf-8')).toBe('extra content')
    expect(Array.from(readFileSync(join(dir, 'assets', 'logo.bin')))).toEqual(Array.from(binary))
    // Provenance stamp (P2)
    const installed = readFileSync(join(dir, 'SKILL.md'), 'utf-8')
    expect(installed).toContain('source: github')
    expect(installed).toContain('installedAt:')
    // Every request stayed on the two whitelisted hosts.
    for (const url of fetchedUrls) {
      expect(url.startsWith('https://api.github.com/') || url.startsWith('https://raw.githubusercontent.com/')).toBe(true)
    }

    // …and the list surfaces the stamp as provenance.
    install()
    const host = createHost()
    const list = (await host.dispatch('listGlobalSkills', [])) as {
      ok: true
      result: Array<{ name: string; provenance?: string }>
    }
    const entry = list.result.find((s) => s.name === 'demo-skill')
    expect(entry?.provenance).toBe('github')
  })

  test('repo-root skill (path: "") installs the whole repository', async () => {
    route({
      tree: [
        { path: 'SKILL.md', size: ROOT_SKILL_MD.length },
        { path: 'helpers/util.js', size: 12 },
      ],
      files: { 'SKILL.md': ROOT_SKILL_MD, 'helpers/util.js': 'console.log()' },
    })
    const res = await dispatchResult('downloadGithubSkill', downloadPayload({ path: '' }))
    expect(res.ok).toBe(true)
    expect(res.name).toBe('root-skill')
    expect(existsSync(join(agentsRoot, 'root-skill', 'SKILL.md'))).toBe(true)
    expect(readFileSync(join(agentsRoot, 'root-skill', 'helpers', 'util.js'), 'utf-8')).toBe(
      'console.log()',
    )
  })

  test('duplicate → exists through dispatch; confirm overwrites the whole folder', async () => {
    install()
    const host = createHost()

    // Normalize state first (confirm works for both fresh and existing), so
    // the duplicate check is deterministic whether run alone or in sequence.
    route({
      tree: [{ path: 'skills/demo/SKILL.md', size: SKILL_MD.length }],
      files: { 'skills/demo/SKILL.md': SKILL_MD },
    })
    expect(
      (await host.dispatch('downloadGithubSkill', [downloadPayload({ confirm: true })])).ok,
    ).toBe(true)

    // Duplicate without confirm → failure envelope keeps `exists`.
    route({
      tree: [{ path: 'skills/demo/SKILL.md', size: SKILL_MD.length }],
      files: { 'skills/demo/SKILL.md': SKILL_MD },
    })
    const dup = (await host.dispatch('downloadGithubSkill', [downloadPayload()])) as {
      ok: boolean
      exists?: boolean
      name?: string
      error?: string
    }
    expect(dup.ok).toBe(false)
    expect(dup.exists).toBe(true)
    // The overwrite dialog is labelled with the FRONTMATTER name, not a path
    // tail / repo string (skills review #2).
    expect(dup.name).toBe('demo-skill')
    expect(dup.error).toContain('already exists')

    // Confirm → overwritten with the v2 content.
    const v2 = SKILL_MD.replace('# Demo', '# Demo v2')
    route({
      tree: [{ path: 'skills/demo/SKILL.md', size: v2.length }],
      files: { 'skills/demo/SKILL.md': v2 },
    })
    const confirmed = await host.dispatch('downloadGithubSkill', [
      downloadPayload({ confirm: true }),
    ])
    expect(confirmed.ok).toBe(true)
    expect(readFileSync(join(agentsRoot, 'demo-skill', 'SKILL.md'), 'utf-8')).toContain('Demo v2')
  })

  test('quota skips are reported as warning (file cap + single-file cap)', async () => {
    install()
    const tree: Array<{ path: string; size: number }> = [
      { path: 'skills/demo/SKILL.md', size: 1024 },
      { path: 'skills/demo/too-big.md', size: 300 * 1024 }, // > 200KB → skipped
    ]
    const files: Record<string, Uint8Array | string> = { 'skills/demo/SKILL.md': SKILL_MD }
    for (let i = 1; i <= 31; i++) {
      const p = `skills/demo/f${i}.md`
      tree.push({ path: p, size: 10_240 })
      files[p] = `file ${i}`
    }
    route({ tree, files })
    // confirm:true → deterministic whether demo-skill already exists or not.
    const res = await downloadGithubSkill(downloadPayload({ confirm: true }))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.warning).toContain('larger than 200KB')
    expect(res.warning).toContain('exceeds the 30-file limit')

    // 30 files landed: SKILL.md + 29 of the small ones (too-big never fetched).
    const dir = join(agentsRoot, 'demo-skill')
    const count = (d: string): number =>
      readdirSync(d, { withFileTypes: true }).reduce(
        (n, e) => n + (e.isDirectory() ? count(join(d, e.name)) : 1),
        0,
      )
    expect(count(dir)).toBe(30)
    expect(existsSync(join(dir, 'too-big.md'))).toBe(false)
    expect(fetchedUrls.some((u) => u.includes('too-big.md'))).toBe(false)
  })

  test('skip warnings are capped: 5 quoted entries + a count of the rest (skills review #5)', async () => {
    install()
    // SKILL.md + 40 small files → 30 accepted, 11 skipped: only the first 5
    // skip reasons are quoted, the remainder become a count — a repo-root
    // install from a large repo must not serialize thousands of entries.
    const tree: Array<{ path: string; size: number }> = [
      { path: 'skills/demo/SKILL.md', size: SKILL_MD.length },
    ]
    const files: Record<string, Uint8Array | string> = { 'skills/demo/SKILL.md': SKILL_MD }
    for (let i = 1; i <= 40; i++) {
      const p = `skills/demo/g${i}.md`
      tree.push({ path: p, size: 10_240 })
      files[p] = `file ${i}`
    }
    route({ tree, files })
    const res = await downloadGithubSkill(downloadPayload({ confirm: true }))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // First 5 skips (g30..g34) are quoted…
    expect(res.warning).toContain('"skills/demo/g30.md" exceeds the 30-file limit')
    expect(res.warning).toContain('"skills/demo/g34.md"')
    // …the other 6 are only counted…
    expect(res.warning).toContain('and 6 more skipped files')
    expect(res.warning).not.toContain('skills/demo/g35.md')
    // 30 files still landed: SKILL.md + g1..g29 (g30+ never fetched).
    expect(existsSync(join(agentsRoot, 'demo-skill', 'g29.md'))).toBe(true)
    expect(existsSync(join(agentsRoot, 'demo-skill', 'g30.md'))).toBe(false)
  })

  test('a file that would push the total over 2MB is skipped with a warning', async () => {
    install()
    // 10 × 200KB passes (1024 + 10×204,800 = 2,049,024 ≤ 2MB); the 11th
    // would exceed the total — it must be pre-skipped, never fetched.
    const chunk = new Uint8Array(200 * 1024).fill(7)
    const tree: Array<{ path: string; size: number }> = [
      { path: 'skills/demo/SKILL.md', size: 1024 },
    ]
    const files: Record<string, Uint8Array | string> = { 'skills/demo/SKILL.md': SKILL_MD }
    for (let i = 1; i <= 11; i++) {
      const p = `skills/demo/c${i}.bin`
      tree.push({ path: p, size: chunk.length })
      files[p] = chunk
    }
    route({ tree, files })
    const res = await downloadGithubSkill(downloadPayload({ confirm: true }))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.warning).toContain('2MB total limit')
    expect(existsSync(join(agentsRoot, 'demo-skill', 'c10.bin'))).toBe(true)
    expect(existsSync(join(agentsRoot, 'demo-skill', 'c11.bin'))).toBe(false)
    expect(readFileSync(join(agentsRoot, 'demo-skill', 'c10.bin')).byteLength).toBe(chunk.length)
  })

  test('traversal paths and non-skill folders are refused before any network call', async () => {
    install()
    noNetwork()
    for (const path of ['../evil', 'skills/../../etc', 'C:\\windows']) {
      const res = await downloadGithubSkill(downloadPayload({ path }))
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toContain('Invalid repository path')
    }
    // A folder without SKILL.md: needs the tree, but must then fail without downloading.
    route({ tree: [{ path: 'skills/demo/readme.md', size: 10 }] })
    const noSkill = await downloadGithubSkill(downloadPayload())
    expect(noSkill.ok).toBe(false)
    if (!noSkill.ok) expect(noSkill.error).toContain('SKILL.md')
    expect(fetchedUrls.filter((u) => u.includes('raw.githubusercontent.com'))).toHaveLength(0)
  })

  test('a failed mid-download leaves no skill folder and no temp dirs (atomicity)', async () => {
    install()
    // A name no other test in this file installs — the assertions stay true
    // regardless of run order.
    const ATOMIC_SKILL = `---\nname: atomic-skill\ndescription: Fresh name for the atomicity check.\n---\n\nBody.\n`
    route({
      tree: [
        { path: 'skills/atomic/SKILL.md', size: ATOMIC_SKILL.length },
        { path: 'skills/atomic/references/extra.md', size: 30 },
      ],
      files: { 'skills/atomic/SKILL.md': ATOMIC_SKILL },
      rawStatus: { 'skills/atomic/references/extra.md': 500 },
    })
    const res = await downloadGithubSkill(downloadPayload({ path: 'skills/atomic' }))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('Download failed')

    expect(existsSync(join(agentsRoot, 'atomic-skill'))).toBe(false)
    if (existsSync(agentsRoot)) {
      expect(readdirSync(agentsRoot).filter((n) => n.startsWith('.tmp-'))).toEqual([])
    }
  })
})

/* ─── 4. token plumbing (P2) ─────────────────────────────────────────── */

describe('GitHub token plumbing (P2)', () => {
  test('githubTokenSet tracks the vault through getState', async () => {
    install()
    const host = createHost()
    const flag = async (): Promise<boolean> => {
      const state = (await host.dispatch('getState', [])) as {
        ok: true
        result: { settings: { githubTokenSet: boolean } }
      }
      return state.result.settings.githubTokenSet
    }
    expect(await flag()).toBe(false)
    saveGithubToken('tok-1')
    expect(await flag()).toBe(true)
    saveGithubToken('')
    expect(await flag()).toBe(false)
  })

  test('saveSettings payload: delete runs BEFORE save (retype after removal lands)', async () => {
    install()
    const host = createHost()
    const base = {
      providers: [],
      activeModel: 'x/y',
      reasoningEffort: 'default' as const,
      approvalMode: 'balanced' as const,
    }
    const flag = async (): Promise<boolean> => {
      const state = (await host.dispatch('getState', [])) as {
        ok: true
        result: { settings: { githubTokenSet: boolean } }
      }
      return state.result.settings.githubTokenSet
    }
    try {
      // Save via the payload channel.
      expect((await host.dispatch('saveSettings', [{ ...base, githubToken: 'ghp_1' }])).ok).toBe(true)
      expect(await flag()).toBe(true)
      // Delete flag clears it.
      expect(
        (await host.dispatch('saveSettings', [{ ...base, deleteGithubToken: true }])).ok,
      ).toBe(true)
      expect(await flag()).toBe(false)
      // Both in one payload (sticky delete + fresh retype) → the NEW token wins.
      expect(
        (
          await host.dispatch('saveSettings', [
            { ...base, githubToken: 'ghp_2', deleteGithubToken: true },
          ])
        ).ok,
      ).toBe(true)
      expect(await flag()).toBe(true)
    } finally {
      saveGithubToken('')
    }
  })
})
