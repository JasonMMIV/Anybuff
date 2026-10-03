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
 *   6. Folder-aware import: a pick of a skill's own SKILL.md installs the whole
 *      folder (references/scripts) with NO size or file-count quota, links and
 *      .git / node_modules excluded, and a flat staging dir (Android's /upload)
 *      or a loose document staying single-file. A folder-shaped pick answers
 *      with `folderConfirm` (the exact file list) and installs NOTHING until
 *      the caller re-issues with `confirmFolder` — including a case-variant
 *      `Skill.md`, whose attachments used to drop silently.
 *   7. listGlobalSkills carries the folder's real fileCount.
 *   8. start-run passes `includeHomeSkills` from settings (source-level wiring
 *      assertion — a real run needs the SDK client + network).
 *
 * Env is pinned INSIDE each test body: bun:test hoists describe-level hooks
 * ahead of ALL test bodies in the file (see settings-keys.test.ts note).
 */

import { describe, test, expect, afterAll } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { installHostEnv } from '../env'
import { createHost } from '../index'
import { noEncryptionSecrets } from './helpers'
import {
  countSkillFiles,
  deleteSkill,
  formatSkipWarnings,
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
function install(scope?: 'shared' | 'managed', pickedFilesShareFolder?: boolean): void {
  installHostEnv({
    paths: { dataDir, appDataDir: dataDir, homeDir },
    secrets: noEncryptionSecrets(),
    ...(scope ? { globalSkillsScope: scope } : {}),
    ...(pickedFilesShareFolder === undefined ? {} : { pickedFilesShareFolder }),
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
 * Folder-aware import: a skill is a FOLDER, and its SKILL.md routinely points
 * at sibling files (`references/*.md`, `scripts/*.py`). Importing only the
 * document dropped those SILENTLY, so the installed skill read as working while
 * the model followed instructions to read files that were never there.
 *
 * The gate is the shell seam `pickedFilesShareFolder`: Desktop's dialog returns
 * real paths, Android's SAF picker copies every pick flat into /upload where the
 * parent is a staging area holding the whole pick history.
 */
/** A source skill folder: SKILL.md + references/api.md + scripts/run.py (3 files). */
function seedSourceSkill(name: string, opts?: { bigFile?: boolean }): string {
  const dir = join(dataDir, `src-${name}`)
  mkdirSync(join(dir, 'references'), { recursive: true })
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), validDoc(name, 'Folder-aware import.'), 'utf-8')
  writeFileSync(join(dir, 'references', 'api.md'), '# API reference\n', 'utf-8')
  writeFileSync(join(dir, 'scripts', 'run.py'), 'print("hi")\n', 'utf-8')
  if (opts?.bigFile) writeFileSync(join(dir, 'references', 'huge.md'), 'x'.repeat(300 * 1024), 'utf-8')
  return dir
}

describe('folder-aware importSkillFile', () => {
  test('a folder-shaped pick installs NOTHING until confirmFolder is granted', () => {
    install('shared', true)
    const dir = seedSourceSkill('folder-aware')
    const picked = join(dir, 'SKILL.md')

    // First call = preview. The host writes nothing; it hands back the plan.
    const preview = importSkillFile({ sourcePath: picked })
    expect(preview.ok).toBe(false)
    const plan = 'folderConfirm' in preview ? preview : null
    expect(plan).not.toBeNull()
    if (plan) {
      expect(plan.name).toBe('folder-aware')
      expect(plan.exists).toBe(false)
      // SKILL.md first, then the walk's deterministic order — this list is
      // exactly what a confirmed install writes.
      expect(plan.fileCount).toBe(3)
      expect(plan.files[0]).toBe('SKILL.md')
      expect(plan.files.slice(1)).toEqual(['references/api.md', 'scripts/run.py'])
      expect(plan.warning).toBeUndefined()
    }
    expect(existsSync(join(agentsRoot, 'folder-aware'))).toBe(false)

    // Consent → the same plan lands, whole.
    const res = importSkillFile({ sourcePath: picked, confirmFolder: true })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.name).toBe('folder-aware')
      // Reported so the UI can say "installed (3 files)" — the user must be
      // able to see that the attachments came along.
      expect(res.fileCount).toBe(3)
      expect(res.warning).toBeUndefined()
    }
    const installed = join(agentsRoot, 'folder-aware')
    expect(existsSync(join(installed, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(installed, 'references', 'api.md'))).toBe(true)
    expect(existsSync(join(installed, 'scripts', 'run.py'))).toBe(true)
    // Provenance still stamped on the document, folder mode or not.
    expect(readFileSync(join(installed, 'SKILL.md'), 'utf-8')).toContain('source: file')
  })

  test('the preview says up front that confirming replaces an existing skill', () => {
    install('shared', true)
    const dir = seedSourceSkill('preview-exists')
    expect(importSkillFile({ sourcePath: join(dir, 'SKILL.md'), confirmFolder: true }).ok).toBe(true)

    const preview = importSkillFile({ sourcePath: join(dir, 'SKILL.md') })
    expect(preview.ok).toBe(false)
    const plan = 'folderConfirm' in preview ? preview : null
    expect(plan).not.toBeNull()
    if (plan) {
      // The consent dialog labels the overwrite with the skill's own name and
      // can mention it in the SAME question — one click, not two.
      expect(plan.name).toBe('preview-exists')
      expect(plan.exists).toBe(true)
      expect(plan.fileCount).toBe(3)
    }
    expect(existsSync(join(agentsRoot, 'preview-exists', 'scripts', 'run.py'))).toBe(true)
  })

  test('a case-variant skill.md pick still brings its attachments', () => {
    install('shared', true)
    // `Skill.md` (not `SKILL.md`) is a legal pick on a case-insensitive
    // filesystem. It used to fall through to single-file import and drop
    // references/ silently — the exact bug this feature exists to remove.
    const dir = join(dataDir, 'src-case-variant')
    mkdirSync(join(dir, 'references'), { recursive: true })
    writeFileSync(join(dir, 'Skill.md'), validDoc('case-variant', 'Spelled differently.'), 'utf-8')
    writeFileSync(join(dir, 'references', 'api.md'), '# api\n', 'utf-8')

    const preview = importSkillFile({ sourcePath: join(dir, 'Skill.md') })
    expect(preview.ok).toBe(false)
    const plan = 'folderConfirm' in preview ? preview : null
    expect(plan).not.toBeNull()
    if (plan) {
      // The plan canonicalizes the pick to `SKILL.md` — the name the skill
      // loader looks for — and still counts the attachment.
      expect(plan.files[0]).toBe('SKILL.md')
      expect(plan.fileCount).toBe(2)
    }
    const res = importSkillFile({ sourcePath: join(dir, 'Skill.md'), confirmFolder: true })
    expect(res.ok).toBe(true)
    const installed = join(agentsRoot, 'case-variant')
    expect(existsSync(join(installed, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(installed, 'references', 'api.md'))).toBe(true)
    // The loader keys on the exact name: an installed `Skill.md` would be
    // invisible to listSkills on a case-sensitive filesystem.
    expect(countSkillFiles(installed)).toBe(2)
  })

  test('the folder name comes from frontmatter, not the picked folder', () => {
    install('shared', true)
    // A downloaded archive unpacks to `anthropics-skills-1.2.3/SKILL.md`; the
    // skill's own name is what the loader keys on.
    const dir = join(dataDir, 'anthropics-skills-1.2.3')
    mkdirSync(join(dir, 'references'), { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), validDoc('pdf-forms', 'Renamed on install.'), 'utf-8')
    writeFileSync(join(dir, 'references', 'fields.md'), '# fields\n', 'utf-8')

    const res = importSkillFile({ sourcePath: join(dir, 'SKILL.md'), confirmFolder: true })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.name).toBe('pdf-forms')
    expect(existsSync(join(agentsRoot, 'pdf-forms', 'references', 'fields.md'))).toBe(true)
  })

  test('a SKILL.md sitting among unrelated files previews them instead of sweeping them', () => {
    install('shared', true)
    // The real hazard this feature has to survive: a SKILL.md beside ordinary
    // files (downloaded raw into Downloads). Without the consent gate the whole
    // folder installed unasked — every neighbour read into memory and written
    // into ~/.agents/skills with no warning.
    const dir = join(dataDir, 'download-folder')
    mkdirSync(join(dir, 'photos'), { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), validDoc('downloaded-skill', 'Raw download.'), 'utf-8')
    writeFileSync(join(dir, 'invoice.pdf'), 'not a skill file', 'utf-8')
    writeFileSync(join(dir, 'photos', 'trip.jpg'), 'jpeg-ish', 'utf-8')

    const preview = importSkillFile({ sourcePath: join(dir, 'SKILL.md') })
    const plan = 'folderConfirm' in preview ? preview : null
    expect(plan).not.toBeNull()
    if (plan) {
      expect(plan.files[0]).toBe('SKILL.md')
      // Every neighbour is on the list — that is what consent means.
      expect([...plan.files].sort()).toEqual(
        ['SKILL.md', 'invoice.pdf', 'photos/trip.jpg'].sort(),
      )
      expect(plan.fileCount).toBe(3)
    }
    // Declining = simply not re-issuing the call. Nothing was written.
    expect(existsSync(join(agentsRoot, 'downloaded-skill'))).toBe(false)
  })

  test('a loose document (not named SKILL.md) never sweeps its neighbours', () => {
    install('shared', true)
    // Downloads/SKILL.md next to unrelated files is the hazard: folder mode is
    // anchored on the convention name, so anything else stays a single file.
    const dir = join(dataDir, 'downloads')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'my-skill.md'), validDoc('loose-skill', 'A loose file.'), 'utf-8')
    writeFileSync(join(dir, 'invoice.pdf'), 'not a skill file', 'utf-8')

    const res = importSkillFile({ sourcePath: join(dir, 'my-skill.md') })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.fileCount).toBeUndefined()
    expect(existsSync(join(agentsRoot, 'loose-skill', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(agentsRoot, 'loose-skill', 'invoice.pdf'))).toBe(false)
  })

  test('a SKILL.md folder holding only itself takes the single-file path', () => {
    install('shared', true)
    const dir = join(dataDir, 'src-lonely')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), validDoc('lonely-skill', 'No attachments.'), 'utf-8')

    const res = importSkillFile({ sourcePath: join(dir, 'SKILL.md') })
    expect(res.ok).toBe(true)
    // No fileCount → the UI shows a plain "installed" line.
    if (res.ok) expect(res.fileCount).toBeUndefined()
  })

  test('a flat staging dir (Android /upload) installs only the picked file', () => {
    // No seam declared = fail-safe single-file, whatever sits beside the pick.
    install('managed')
    const staging = join(dataDir, 'upload')
    mkdirSync(staging, { recursive: true })
    writeFileSync(join(staging, 'SKILL.md'), validDoc('staged-skill', 'From Android.'), 'utf-8')
    writeFileSync(join(staging, 'IMG_0042.jpg'), 'a photo the user attached earlier', 'utf-8')

    const res = importSkillFile({ sourcePath: join(staging, 'SKILL.md') })
    expect(res.ok).toBe(true)
    expect(existsSync(join(agentsRoot, 'staged-skill', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(agentsRoot, 'staged-skill', 'IMG_0042.jpg'))).toBe(false)
  })

  test('a pick sitting IN a skills root does not sweep the other skills', () => {
    install('shared', true)
    mkdirSync(join(agentsRoot, 'neighbour'), { recursive: true })
    writeFileSync(join(agentsRoot, 'neighbour', 'SKILL.md'), validDoc('neighbour'), 'utf-8')
    // `~/.agents/skills/SKILL.md` is a container of skills, not a skill.
    writeFileSync(join(agentsRoot, 'SKILL.md'), validDoc('root-level', 'Odd but legal.'), 'utf-8')

    const res = importSkillFile({ sourcePath: join(agentsRoot, 'SKILL.md') })
    expect(res.ok).toBe(true)
    const installed = join(agentsRoot, 'root-level')
    expect(existsSync(join(installed, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(installed, 'neighbour'))).toBe(false)
    // The pre-existing neighbour skill is untouched.
    expect(existsSync(join(agentsRoot, 'neighbour', 'SKILL.md'))).toBe(true)
  })

  test('oversized attachments are installed, never skipped (no size quota)', () => {
    install('shared', true)
    // A 300KB data file the skill genuinely uses. The old 200KB per-file cap
    // skipped it — producing exactly the half-installed skill this feature
    // exists to eliminate.
    const dir = seedSourceSkill('big-attachment', { bigFile: true })
    const res = importSkillFile({ sourcePath: join(dir, 'SKILL.md'), confirmFolder: true })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.fileCount).toBe(4)
      expect(res.warning).toBeUndefined()
    }
    const installed = join(agentsRoot, 'big-attachment', 'references', 'huge.md')
    expect(existsSync(installed)).toBe(true)
    expect(readFileSync(installed).byteLength).toBe(300 * 1024)
  })

  test('.git and node_modules are never walked', () => {
    install('shared', true)
    const dir = seedSourceSkill('no-vcs')
    mkdirSync(join(dir, '.git'), { recursive: true })
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf-8')
    mkdirSync(join(dir, 'node_modules', 'left-pad'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n', 'utf-8')

    const res = importSkillFile({ sourcePath: join(dir, 'SKILL.md'), confirmFolder: true })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.fileCount).toBe(3)
    const installed = join(agentsRoot, 'no-vcs')
    expect(existsSync(join(installed, '.git'))).toBe(false)
    expect(existsSync(join(installed, 'node_modules'))).toBe(false)
  })

  test('links inside the folder are skipped, not followed', () => {
    install('shared', true)
    const dir = seedSourceSkill('linked-skill')
    // A link would pull content from outside the folder the user picked — and a
    // link cycle would never terminate. Windows refuses symlink creation for
    // unprivileged processes, so this asserts only when the platform allows it.
    const outside = join(dataDir, 'outside-secret.md')
    writeFileSync(outside, 'SECRET\n', 'utf-8')
    let linked = false
    try {
      symlinkSync(outside, join(dir, 'references', 'link.md'))
      linked = true
    } catch {
      // no symlink privilege on this host — nothing to assert
    }
    const preview = importSkillFile({ sourcePath: join(dir, 'SKILL.md') })
    const plan = 'folderConfirm' in preview ? preview : null
    expect(plan).not.toBeNull()
    if (plan) {
      expect(plan.fileCount).toBe(3)
      // The skip is visible BEFORE consent, not only after the fact.
      if (linked) expect(plan.warning).toContain('is a link')
    }
    const res = importSkillFile({ sourcePath: join(dir, 'SKILL.md'), confirmFolder: true })
    expect(res.ok).toBe(true)
    if (res.ok) {
      // The link is reported, never counted — and never read.
      expect(res.fileCount).toBe(3)
      if (linked) expect(res.warning).toContain('is a link')
    }
    const installed = join(agentsRoot, 'linked-skill', 'references')
    expect(existsSync(join(installed, 'api.md'))).toBe(true)
    // The link is never copied — neither the target's bytes nor a dangling path.
    expect(existsSync(join(installed, 'link.md'))).toBe(false)
  })

  test('re-import over an installed skill asks to confirm, then replaces the folder', () => {
    install('shared', true)
    const dir = seedSourceSkill('reimport')
    expect(
      importSkillFile({ sourcePath: join(dir, 'SKILL.md'), confirmFolder: true }).ok,
    ).toBe(true)

    // The second pick is answered by the PREVIEW, which already flags the
    // replacement — one dialog covers "install this folder" and "it replaces
    // the skill you already have".
    const second = importSkillFile({ sourcePath: join(dir, 'SKILL.md') })
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.exists).toBe(true)
      // The confirm dialog labels the overwrite with the skill's own name.
      expect(second.name).toBe('reimport')
    }

    // Drop an attachment, then confirm: the folder is replaced wholesale, so a
    // file that no longer exists upstream must not linger.
    rmSync(join(dir, 'scripts'), { recursive: true, force: true })
    const third = importSkillFile({
      sourcePath: join(dir, 'SKILL.md'),
      confirm: true,
      confirmFolder: true,
    })
    expect(third.ok).toBe(true)
    expect(existsSync(join(agentsRoot, 'reimport', 'references', 'api.md'))).toBe(true)
    expect(existsSync(join(agentsRoot, 'reimport', 'scripts'))).toBe(false)
  })

  test('a broken SKILL.md in a folder installs NOTHING (no half-skill)', () => {
    install('shared', true)
    const dir = join(dataDir, 'src-broken')
    mkdirSync(join(dir, 'references'), { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: broken-skill\n---\n\nNo description.\n', 'utf-8')
    writeFileSync(join(dir, 'references', 'api.md'), '# api\n', 'utf-8')

    // Validation of the full document happens at install time (the preview
    // only needs the name) — and it fails with nothing written: no half-skill.
    expect(
      importSkillFile({ sourcePath: join(dir, 'SKILL.md'), confirmFolder: true }).ok,
    ).toBe(false)
    expect(existsSync(join(agentsRoot, 'broken-skill'))).toBe(false)
  })
})

describe('skip warnings stay bounded', () => {
  // A folder with hundreds of links must not serialize hundreds of reasons into
  // one string (the GitHub path hit this on repo-root installs — skills review
  // #5). The formatter is unit-locked here because the download path no longer
  // produces skips at all; the folder walk still does (links, unreadable files).
  test('quotes at most 5 reasons and counts the rest', () => {
    expect(formatSkipWarnings([])).toBeUndefined()
    expect(formatSkipWarnings(['"a" is a link'])).toBe('skipped "a" is a link')
    const many = Array.from({ length: 9 }, (_, i) => `"f${i}" is a link`)
    const out = formatSkipWarnings(many)
    expect(out).toContain('"f0" is a link')
    expect(out).toContain('"f4" is a link')
    expect(out).not.toContain('"f5" is a link')
    expect(out).toContain('and 4 more skipped files')
  })
})

describe('Skills list file counts', () => {
  test('countSkillFiles reports attachments; listGlobalSkills carries it', async () => {
    install('shared', true)
    const dir = seedSourceSkill('counted')
    expect(
      importSkillFile({ sourcePath: join(dir, 'SKILL.md'), confirmFolder: true }).ok,
    ).toBe(true)

    expect(countSkillFiles(join(agentsRoot, 'counted'))).toBe(3)

    const host = createHost()
    const listed = (await host.dispatch('listGlobalSkills', [])) as {
      ok: boolean
      result?: { name: string; fileCount?: number }[]
    }
    const skills = listed.result ?? []
    const counted = skills.find((s) => s.name === 'counted')
    expect(counted?.fileCount).toBe(3)
  })

  test('a large skill folder installs whole — no file-count quota either', () => {
    install('shared', true)
    const dir = join(dataDir, 'src-many')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), validDoc('many-files'), 'utf-8')
    for (let i = 0; i < 40; i++) writeFileSync(join(dir, `ref-${i}.md`), `# ref ${i}\n`, 'utf-8')
    const res = importSkillFile({ sourcePath: join(dir, 'SKILL.md'), confirmFolder: true })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.fileCount).toBe(41)
      expect(res.warning).toBeUndefined()
    }
    // Alphabetically `ref-*` sorts before `SKILL.md` — the skill document is
    // found and installed regardless of sibling ordering.
    expect(existsSync(join(agentsRoot, 'many-files', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(agentsRoot, 'many-files', 'ref-39.md'))).toBe(true)
    expect(countSkillFiles(dir)).toBe(41)
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

  test('a folder-shaped pick keeps its whole folderConfirm plan through dispatch', async () => {
    install('shared', true)
    const host = createHost()
    const dir = join(dataDir, 'dispatch-folder')
    mkdirSync(join(dir, 'references'), { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), validDoc('dispatch-folder-skill', 'Folder.'), 'utf-8')
    writeFileSync(join(dir, 'references', 'api.md'), '# api\n', 'utf-8')

    const preview = (await host.dispatch('importSkillFile', [{ sourcePath: join(dir, 'SKILL.md') }])) as {
      ok: false
      folderConfirm?: boolean
      files?: string[]
      fileCount?: number
      exists?: boolean
    }
    // The consent envelope is a SUPERSET failure — it must reach the renderer
    // intact (the Electron host-bridge returns failure envelopes whole; this
    // locks the dispatcher leg).
    expect(preview.ok).toBe(false)
    expect(preview.folderConfirm).toBe(true)
    expect(preview.files).toEqual(['SKILL.md', 'references/api.md'])
    expect(preview.exists).toBe(false)
    expect(existsSync(join(agentsRoot, 'dispatch-folder-skill'))).toBe(false)

    const done = (await host.dispatch('importSkillFile', [
      { sourcePath: join(dir, 'SKILL.md'), confirmFolder: true },
    ])) as { ok: boolean }
    expect(done.ok).toBe(true)
    expect(existsSync(join(agentsRoot, 'dispatch-folder-skill', 'references', 'api.md'))).toBe(true)
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
