import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveProjectKey } from '../run/project-key'

const root = mkdtempSync(join(tmpdir(), 'host-core-project-key-'))

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

describe('resolveProjectKey', () => {
  test('uses the realpath for a plain directory', async () => {
    const dir = join(root, 'plain')
    mkdirSync(dir)
    const expected = realpathSync(dir)
    expect(await resolveProjectKey(dir)).toBe(process.platform === 'win32' ? expected.toLowerCase() : expected)
  })

  test('resolves a monorepo subdirectory to the git top level', async () => {
    const repo = join(root, 'repo')
    mkdirSync(repo)
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' })
    const sub = join(repo, 'packages', 'app')
    mkdirSync(sub, { recursive: true })

    expect(await resolveProjectKey(sub)).toBe(await resolveProjectKey(repo))
  })

  test('is stable across a trailing separator and, on Windows, case', async () => {
    const dir = join(root, 'stable')
    mkdirSync(dir)
    const key = await resolveProjectKey(dir)
    expect(await resolveProjectKey(`${dir}${process.platform === 'win32' ? '\\' : '/'}`)).toBe(key)
    if (process.platform === 'win32') expect(key).toBe(key.toLowerCase())
  })
})
