/**
 * Skills page contract tests (skills plan §9 / P0).
 *
 * Locks:
 *   1. `globalSkillsEnabled` — default ON, legacy files upgrade to ON, and a
 *      saveSettings payload WITHOUT the field never resets it (ADR-27 MC-0
 *      save-payload race lesson — R3 acceptance line).
 *   2. `globalSkillsEditable` — DERIVED from HostEnv.globalSkillsScope, never
 *      persisted.
 *   3. The D6 scope gate: saveSkillFile/deleteSkill refuse under 'shared'
 *      (Desktop) and under an ABSENT scope (fail-safe), and work under
 *      'managed' (Android). Channels are the boundary — this is host-side
 *      enforcement, not a UI concern.
 *   4. installSkill validation chain: name regex, frontmatter schema, folder
 *      name = frontmatter name, exists-confirm, containment.
 *   5. saveSkillFile keeps the old file on validation failure and locks the
 *      name; deleteSkill only removes direct children holding a SKILL.md.
 *   6. start-run passes `includeHomeSkills` from settings (source-level wiring
 *      assertion — a real run needs the SDK client + network).
 *
 * Env is pinned INSIDE each test body: bun:test hoists describe-level hooks
 * ahead of ALL test bodies in the file (see settings-keys.test.ts note).
 */

import { describe, test, expect, afterAll } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { installHostEnv } from '../env'
import { createHost } from '../index'
import { noEncryptionSecrets } from './helpers'
import {
  deleteSkill,
  globalSkillRoots,
  importSkillFile,
  installSkill,
  installSkillMulti,
  saveSkillFile,
} from '../skills/install-skill'

const dataDir = mkdtempSync(join(tmpdir(), 'host-core-skills-'))
const homeDir = mkdtempSync(join(tmpdir(), 'host-core-skills-home-'))
process.env.ANYBUFF_PROVIDER_CONFIG = join(dataDir, 'anybuff.json')

const agentsRoot = join(homeDir, '.agents', 'skills')

/** Install the host env with a given scope (undefined = the fail-safe default). */
function install(scope?: 'shared' | 'managed'): void {
  installHostEnv({
    paths: { dataDir, appDataDir: dataDir, homeDir },
    secrets: noEncryptionSecrets(),
    ...(scope ? { globalSkillsScope: scope } : {}),
  })
}

function validDoc(name: string, description = 'A test skill.'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nBody text.\n`
}

afterAll(() => {
  for (const dir of [dataDir, homeDir]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
})

describe('globalSkillsEnabled (D2 — default ON)', () => {
  test('getAppSettings defaults to ON for a fresh settings file', async () => {
    install('shared')
    const host = createHost()
    const state = (await host.dispatch('getState', [])) as {
      ok: true
      result: { settings: { globalSkillsEnabled: boolean } }
    }
    expect(state.result.settings.globalSkillsEnabled).toBe(true)
  })

  test('legacy settings file without the field upgrades to ON', () => {
    install('shared')
    // Simulate a pre-skills settings file: no globalSkillsEnabled key.
    writeFileSync(
      join(dataDir, 'AnyBuff-app-settings.json'),
      JSON.stringify({ providers: [], activeModel: 'x/y', reasoningEffort: 'default', approvalMode: 'balanced' }),
    )
    const host = createHost()
    return host.dispatch('getState', []).then((state) => {
      const inner = state as { ok: true; result: { settings: Record<string, unknown> } }
      expect(inner.result.settings.globalSkillsEnabled).toBe(true)
    })
  })

  test('saveSettings flips it, and a later payload WITHOUT the field keeps it (R3)', async () => {
    install('shared')
    const host = createHost()
    const base = {
      providers: [],
      activeModel: 'x/y',
      reasoningEffort: 'default' as const,
      approvalMode: 'balanced' as const,
    }
    // Turn OFF with the field present.
    expect((await host.dispatch('saveSettings', [{ ...base, globalSkillsEnabled: false }])).ok).toBe(true)
    let state = (await host.dispatch('getState', [])) as {
      ok: true
      result: { settings: { globalSkillsEnabled: boolean } }
    }
    expect(state.result.settings.globalSkillsEnabled).toBe(false)

    // Save again WITHOUT the field (e.g. the composer's guardrail save) — the
    // value must survive; an absent field is a no-op, never a reset.
    expect((await host.dispatch('saveSettings', [base])).ok).toBe(true)
    state = (await host.dispatch('getState', [])) as typeof state
    expect(state.result.settings.globalSkillsEnabled).toBe(false)

    // Back ON.
    expect((await host.dispatch('saveSettings', [{ ...base, globalSkillsEnabled: true }])).ok).toBe(true)
    state = (await host.dispatch('getState', [])) as typeof state
    expect(state.result.settings.globalSkillsEnabled).toBe(true)
  })
})

describe('globalSkillsEditable (D6 — derived, never persisted)', () => {
  test("shared scope → editable=false", async () => {
    install('shared')
    const host = createHost()
    const state = (await host.dispatch('getState', [])) as {
      ok: true
      result: { settings: { globalSkillsEditable: boolean } }
    }
    expect(state.result.settings.globalSkillsEditable).toBe(false)
  })

  test("managed scope → editable=true", async () => {
    install('managed')
    const host = createHost()
    const state = (await host.dispatch('getState', [])) as {
      ok: true
      result: { settings: { globalSkillsEditable: boolean } }
    }
    expect(state.result.settings.globalSkillsEditable).toBe(true)
  })

  test('globalSkillsEditable never appears in the persisted settings file', async () => {
    install('managed')
    const host = createHost()
    await host.dispatch('saveSettings', [
      { providers: [], activeModel: 'x/y', reasoningEffort: 'default', approvalMode: 'balanced' },
    ])
    const raw = readFileSync(join(dataDir, 'AnyBuff-app-settings.json'), 'utf-8')
    expect(raw).not.toContain('globalSkillsEditable')
    // The toggle itself IS persisted.
    expect(raw).toContain('globalSkillsEnabled')
  })
})

describe('D6 scope gate — saveSkillFile / deleteSkill', () => {
  const skillPath = join(agentsRoot, 'gate-skill', 'SKILL.md')

  function seedSkill(): void {
    mkdirSync(join(agentsRoot, 'gate-skill'), { recursive: true })
    writeFileSync(skillPath, validDoc('gate-skill'), 'utf-8')
  }

  test("shared scope (Desktop) refuses edit AND delete with an English message", () => {
    install('shared')
    seedSkill()
    const save = saveSkillFile({ path: skillPath, content: validDoc('gate-skill', 'Changed.') })
    expect(save.ok).toBe(false)
    if (!save.ok) expect(save.error).toContain('shared with other tools')
    const del = deleteSkill({ path: skillPath })
    expect(del.ok).toBe(false)
    if (!del.ok) expect(del.error).toContain('shared with other tools')
    // File untouched.
    expect(readFileSync(skillPath, 'utf-8')).toContain('A test skill.')
  })

  test('absent scope (unregistered shell) refuses — fail-safe default', () => {
    install(undefined)
    seedSkill()
    expect(saveSkillFile({ path: skillPath, content: validDoc('gate-skill') }).ok).toBe(false)
    expect(deleteSkill({ path: skillPath }).ok).toBe(false)
    expect(existsSync(skillPath)).toBe(true)
  })

  test("managed scope (Android) allows edit and delete", () => {
    install('managed')
    seedSkill()
    const save = saveSkillFile({ path: skillPath, content: validDoc('gate-skill', 'Edited by user.') })
    expect(save.ok).toBe(true)
    expect(readFileSync(skillPath, 'utf-8')).toContain('Edited by user.')

    const del = deleteSkill({ path: skillPath })
    expect(del.ok).toBe(true)
    expect(existsSync(join(agentsRoot, 'gate-skill'))).toBe(false)
  })

  test('delete accepts the folder path as well as the SKILL.md path', () => {
    install('managed')
    seedSkill()
    const del = deleteSkill({ path: join(agentsRoot, 'gate-skill') })
    expect(del.ok).toBe(true)
    expect(existsSync(join(agentsRoot, 'gate-skill'))).toBe(false)
  })
})

describe('installSkill validation chain (D3)', () => {
  test('rejects invalid names (uppercase, underscore, traversal)', () => {
    install('shared')
    expect(installSkill({ name: 'Bad_Name', content: validDoc('Bad_Name') }).ok).toBe(false)
    expect(installSkill({ name: '../evil', content: validDoc('../evil') }).ok).toBe(false)
    expect(installSkill({ name: '', content: validDoc('x') }).ok).toBe(false)
    expect(installSkill({ name: 'trailing-', content: validDoc('trailing-') }).ok).toBe(false)
  })

  test('rejects a document whose frontmatter name ≠ folder name', () => {
    install('shared')
    const res = installSkill({ name: 'right-name', content: validDoc('wrong-name') })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('frontmatter')
  })

  test('rejects missing description', () => {
    install('shared')
    const res = installSkill({ name: 'no-desc', content: '---\nname: no-desc\n---\n\nBody.\n' })
    expect(res.ok).toBe(false)
  })

  test('installs into <home>/.agents/skills/<name>/SKILL.md (ADR-13 write)', () => {
    install('shared')
    const res = installSkill({ name: 'installed-skill', content: validDoc('installed-skill') })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.path).toBe(join(agentsRoot, 'installed-skill', 'SKILL.md'))
      expect(existsSync(res.path)).toBe(true)
    }
    expect(existsSync(join(homeDir, '.claude', 'skills', 'installed-skill'))).toBe(false)
  })

  test('same name without confirm → { exists: true }; with confirm → overwrites', () => {
    install('shared')
    const first = installSkill({ name: 'dup-skill', content: validDoc('dup-skill', 'First.') })
    expect(first.ok).toBe(true)

    const second = installSkill({ name: 'dup-skill', content: validDoc('dup-skill', 'Second.') })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.exists).toBe(true)
    // First install still intact until confirmed.
    expect(readFileSync(join(agentsRoot, 'dup-skill', 'SKILL.md'), 'utf-8')).toContain('First.')

    const third = installSkill({ name: 'dup-skill', content: validDoc('dup-skill', 'Second.'), confirm: true })
    expect(third.ok).toBe(true)
    expect(readFileSync(join(agentsRoot, 'dup-skill', 'SKILL.md'), 'utf-8')).toContain('Second.')
  })

  test('an empty same-name folder does NOT demand confirm (SKILL.md is the exists marker)', () => {
    install('shared')
    // A leftover empty folder — user-created, or a previous failed write —
    // holds no skill; blocking first install behind "overwrite" would be a
    // dead end (review finding: exists was keyed on the directory).
    mkdirSync(join(agentsRoot, 'leftover-empty'), { recursive: true })
    const res = installSkill({ name: 'leftover-empty', content: validDoc('leftover-empty') })
    expect(res.ok).toBe(true)
    expect(existsSync(join(agentsRoot, 'leftover-empty', 'SKILL.md'))).toBe(true)
  })

  test('install works under shared scope too (only edit/delete are gated)', () => {
    install('shared')
    const res = installSkill({ name: 'shared-install', content: validDoc('shared-install') })
    expect(res.ok).toBe(true)
  })
})

describe('installSkillMulti exists envelope (skills review #2)', () => {
  test('duplicate → { exists: true } carrying the FRONTMATTER name; confirm overwrites', () => {
    install('shared')
    const doc = validDoc('multi-exists')
    const files = [{ path: 'SKILL.md', data: Buffer.from(doc, 'utf-8') }]
    const first = installSkillMulti({ name: 'multi-exists', files })
    expect(first.ok).toBe(true)

    const second = installSkillMulti({ name: 'multi-exists', files })
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.exists).toBe(true)
      // The confirm dialog labels the overwrite with the skill's own name —
      // not a folder tail / repo string (skills review #2).
      expect(second.name).toBe('multi-exists')
    }
    // First install still intact until confirmed.
    expect(readFileSync(join(agentsRoot, 'multi-exists', 'SKILL.md'), 'utf-8')).toBe(doc)

    const third = installSkillMulti({ name: 'multi-exists', files, confirm: true })
    expect(third.ok).toBe(true)
  })
})

describe('saveSkillFile validation (managed scope)', () => {
  test('broken frontmatter is rejected and the old file is preserved', () => {
    install('managed')
    const path = join(agentsRoot, 'keep-old', 'SKILL.md')
    mkdirSync(join(agentsRoot, 'keep-old'), { recursive: true })
    writeFileSync(path, validDoc('keep-old', 'Original.'), 'utf-8')

    const res = saveSkillFile({ path, content: 'not frontmatter at all' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('not changed')
    expect(readFileSync(path, 'utf-8')).toContain('Original.')
  })

  test('renaming via edit is rejected (name locked to the folder)', () => {
    install('managed')
    const path = join(agentsRoot, 'locked-name', 'SKILL.md')
    mkdirSync(join(agentsRoot, 'locked-name'), { recursive: true })
    writeFileSync(path, validDoc('locked-name'), 'utf-8')

    const res = saveSkillFile({ path, content: validDoc('other-name') })
    expect(res.ok).toBe(false)
    expect(readFileSync(path, 'utf-8')).toContain('name: locked-name')
  })

  test('paths outside the global roots are refused (traversal)', () => {
    install('managed')
    const outside = join(homeDir, 'outside', 'SKILL.md')
    mkdirSync(join(homeDir, 'outside'), { recursive: true })
    writeFileSync(outside, validDoc('outside'), 'utf-8')
    expect(saveSkillFile({ path: outside, content: validDoc('outside') }).ok).toBe(false)
    expect(deleteSkill({ path: outside }).ok).toBe(false)
  })

  test('nested paths deeper than one level are refused', () => {
    install('managed')
    const nested = join(agentsRoot, 'outer', 'inner', 'SKILL.md')
    mkdirSync(join(agentsRoot, 'outer', 'inner'), { recursive: true })
    writeFileSync(nested, validDoc('inner'), 'utf-8')
    expect(saveSkillFile({ path: nested, content: validDoc('inner') }).ok).toBe(false)
    expect(deleteSkill({ path: nested }).ok).toBe(false)
  })

  test('deleting the global root itself is refused', () => {
    install('managed')
    mkdirSync(agentsRoot, { recursive: true })
    expect(deleteSkill({ path: agentsRoot }).ok).toBe(false)
    expect(existsSync(agentsRoot)).toBe(true)
  })
})

describe('importSkillFile', () => {
  test('a valid picked file installs verbatim under its own frontmatter name', () => {
    install('shared')
    const src = join(dataDir, 'picked-skill.md')
    writeFileSync(src, validDoc('picked-skill', 'From a file.'), 'utf-8')
    const res = importSkillFile({ sourcePath: src })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.path).toBe(join(agentsRoot, 'picked-skill', 'SKILL.md'))
    expect(readFileSync(join(agentsRoot, 'picked-skill', 'SKILL.md'), 'utf-8')).toContain('From a file.')
  })

  test('a file without frontmatter fails with a clear error', () => {
    install('shared')
    const src = join(dataDir, 'plain.md')
    writeFileSync(src, '# Just markdown\n', 'utf-8')
    const res = importSkillFile({ sourcePath: src })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('frontmatter')
  })

  test('an invalid frontmatter name fails', () => {
    install('shared')
    const src = join(dataDir, 'bad-name.md')
    writeFileSync(src, validDoc('Bad_Name'), 'utf-8')
    const res = importSkillFile({ sourcePath: src })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('Invalid skill name')
  })

  test('a missing file fails without throwing', () => {
    install('shared')
    expect(importSkillFile({ sourcePath: join(dataDir, 'nope.md') }).ok).toBe(false)
  })
})

/**
 * Review finding 1: the confirm-overwrite flow branches on `exists`, which
 * used to survive only at the unit level — dispatcher and transports must
 * carry it too (the WS leg is locked in ws-server.test.ts; the Electron
 * host-bridge passes failure envelopes through whole).
 */
describe('exists-confirm survives the channel layer', () => {
  test('createSkill over an existing name keeps exists:true through dispatch', async () => {
    install('shared')
    const host = createHost()
    const payload = { name: 'dispatch-dup', description: 'A test skill.', body: 'Body text.' }
    expect((await host.dispatch('createSkill', [payload])).ok).toBe(true)

    const second = (await host.dispatch('createSkill', [payload])) as {
      ok: false
      exists?: boolean
      error: string
    }
    expect(second.ok).toBe(false)
    expect(second.exists).toBe(true)
    expect(second.error).toContain('already exists')

    // The confirmed retry installs over it.
    expect((await host.dispatch('createSkill', [{ ...payload, confirm: true }])).ok).toBe(true)
  })

  test('importSkillFile over an existing name keeps exists:true through dispatch', async () => {
    install('shared')
    const host = createHost()
    const src = join(dataDir, 'dup-picked.md')
    writeFileSync(src, validDoc('dispatch-import-dup', 'First.'), 'utf-8')
    expect((await host.dispatch('importSkillFile', [{ sourcePath: src }])).ok).toBe(true)

    const second = (await host.dispatch('importSkillFile', [{ sourcePath: src }])) as {
      ok: false
      exists?: boolean
      error: string
    }
    expect(second.ok).toBe(false)
    expect(second.exists).toBe(true)
  })
})

describe('listGlobalSkills (dispatcher)', () => {
  test('scans both home roots and returns a bare array', async () => {
    install('shared')
    mkdirSync(join(agentsRoot, 'listed-skill'), { recursive: true })
    writeFileSync(join(agentsRoot, 'listed-skill', 'SKILL.md'), validDoc('listed-skill'), 'utf-8')
    const claudeRoot = join(homeDir, '.claude', 'skills', 'claude-skill')
    mkdirSync(claudeRoot, { recursive: true })
    writeFileSync(join(claudeRoot, 'SKILL.md'), validDoc('claude-skill'), 'utf-8')

    const host = createHost()
    const res = (await host.dispatch('listGlobalSkills', [])) as { ok: true; result: Array<{ name: string; root: string }> }
    expect(res.ok).toBe(true)
    const names = res.result.map((s) => s.name)
    expect(names).toContain('listed-skill')
    expect(names).toContain('claude-skill')
    const byName = Object.fromEntries(res.result.map((s) => [s.name, s.root]))
    expect(byName['listed-skill']).toBe('.agents')
    expect(byName['claude-skill']).toBe('.claude')
  })

  test('empty roots → [] (never throws)', async () => {
    install('shared')
    const emptyHome = mkdtempSync(join(tmpdir(), 'host-core-skills-empty-'))
    installHostEnv({
      paths: { dataDir, appDataDir: dataDir, homeDir: emptyHome },
      secrets: noEncryptionSecrets(),
      globalSkillsScope: 'shared',
    })
    const host = createHost()
    const res = (await host.dispatch('listGlobalSkills', [])) as { ok: true; result: unknown }
    expect(Array.isArray(res.result)).toBe(true)
    expect((res.result as unknown[]).length).toBe(0)
    rmSync(emptyHome, { recursive: true, force: true })
    install('shared')
  })

  test('globalSkillRoots points at the shell-declared home dir', () => {
    install('shared')
    const roots = globalSkillRoots()
    expect(roots.map((r) => r.root)).toEqual(['.agents', '.claude'])
    expect(roots[0].dir).toBe(join(homeDir, '.agents', 'skills'))
  })
})

describe('start-run wiring (D4)', () => {
  test('client.run forwards includeHomeSkills from the persisted toggle', () => {
    // A real run needs the SDK client + network; lock the wiring at source
    // level so a refactor can't silently drop the option (it is ONE line in
    // a 1200-line orchestrator, and dropping it halves the feature: the skill
    // tool would stop seeing home skills while /skill:name still works).
    const src = readFileSync(join(import.meta.dir, '..', 'run', 'start-run.ts'), 'utf-8')
    expect(src).toContain('includeHomeSkills: currentSettings.globalSkillsEnabled ?? true')
  })
})

describe('provenance stamps (P2) + dot-dir skip', () => {
  test('createSkill stamps source: manual, importSkillFile stamps file, list shows both', async () => {
    install('shared')
    const host = createHost()
    const res = await host.dispatch('createSkill', [
      { name: 'prov-manual', description: 'Provenance test.', body: 'Body.' },
    ])
    expect(res.ok).toBe(true)
    const manual = readFileSync(join(agentsRoot, 'prov-manual', 'SKILL.md'), 'utf-8')
    expect(manual).toContain('source: manual')
    expect(manual).toContain('installedAt:')

    const src = join(dataDir, 'prov-file.md')
    writeFileSync(src, validDoc('prov-file'), 'utf-8')
    expect(importSkillFile({ sourcePath: src }).ok).toBe(true)
    const fromFile = readFileSync(join(agentsRoot, 'prov-file', 'SKILL.md'), 'utf-8')
    expect(fromFile).toContain('source: file')

    // The list surfaces the stamp as provenance (drives the UI badge).
    const list = (await host.dispatch('listGlobalSkills', [])) as {
      ok: true
      result: Array<{ name: string; provenance?: string }>
    }
    const byName = Object.fromEntries(list.result.map((s) => [s.name, s.provenance]))
    expect(byName['prov-manual']).toBe('manual')
    expect(byName['prov-file']).toBe('file')
    // Pre-provenance skills simply have no badge.
    expect(byName['listed-skill']).toBeUndefined()
  })

  test('an existing metadata block is extended, not clobbered', () => {
    install('shared')
    const doc = `---\nname: prov-merge\ndescription: Keeps metadata.\nmetadata:\n  origin: hand-made\n---\n\nBody.\n`
    const res = installSkill({ name: 'prov-merge', content: doc, source: 'manual' })
    expect(res.ok).toBe(true)
    const out = readFileSync(join(agentsRoot, 'prov-merge', 'SKILL.md'), 'utf-8')
    expect(out).toContain('origin: hand-made')
    expect(out).toContain('source: manual')
  })

  test('unstampable metadata (inline flow) falls back to the original — install still succeeds', () => {
    install('shared')
    const doc = `---\nname: prov-inline\ndescription: Inline metadata.\nmetadata: { a: 1 }\n---\n\nBody.\n`
    const res = installSkill({ name: 'prov-inline', content: doc, source: 'file' })
    expect(res.ok).toBe(true)
    const out = readFileSync(join(agentsRoot, 'prov-inline', 'SKILL.md'), 'utf-8')
    expect(out).toContain('metadata: { a: 1 }')
    expect(out).not.toContain('source: file')
  })

  test('temp/backup dot-dirs are invisible to the list', async () => {
    install('shared')
    mkdirSync(join(agentsRoot, '.tmp-skill-abc'), { recursive: true })
    writeFileSync(join(agentsRoot, '.tmp-skill-abc', 'SKILL.md'), validDoc('tmp-skill-abc'), 'utf-8')
    const host = createHost()
    const list = (await host.dispatch('listGlobalSkills', [])) as {
      ok: true
      result: Array<{ name: string }>
    }
    expect(list.result.map((s) => s.name)).not.toContain('tmp-skill-abc')
    rmSync(join(agentsRoot, '.tmp-skill-abc'), { recursive: true, force: true })
  })
})
