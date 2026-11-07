import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  __resetRunRegistryForTests,
  createHost,
  createRun,
  installHostEnv,
  releaseRun,
  resolveProjectKey,
} from '../index'
import { noEncryptionSecrets } from './helpers'

const dataDir = mkdtempSync(join(tmpdir(), 'host-core-revert-busy-'))
let host: ReturnType<typeof createHost>

beforeAll(() => {
  installHostEnv({
    paths: { dataDir, appDataDir: dataDir, homeDir: dataDir },
    secrets: noEncryptionSecrets(),
  })
  host = createHost()
})

afterAll(() => {
  __resetRunRegistryForTests()
})

describe('work-tree write guard', () => {
  test('gitRevert and gitAccept are blocked while a Build run is active', async () => {
    const projectKey = await resolveProjectKey(dataDir)
    const run = createRun({
      taskId: 'revert-busy-task',
      cwd: dataDir,
      projectKey,
      agentId: 'base2',
      mode: 'default',
    })

    const revert = (await host.dispatch('gitRevert', [
      { cwd: dataDir, file: 'README.md' },
    ])) as { ok: false; code?: string; runningTaskId?: string }
    expect(revert.ok).toBe(false)
    expect(revert.code).toBe('project-busy')
    expect(revert.runningTaskId).toBe('revert-busy-task')

    const accept = (await host.dispatch('gitAccept', [
      { cwd: dataDir, file: 'README.md' },
    ])) as { ok: false; code?: string; runningTaskId?: string }
    expect(accept.ok).toBe(false)
    expect(accept.code).toBe('project-busy')
    expect(accept.runningTaskId).toBe('revert-busy-task')

    releaseRun(run.runId)

    // Build + Plan is the supported same-project pair; a read-only Plan run
    // must not block reviewing the Build result.
    const planRun = createRun({
      taskId: 'plan-task',
      cwd: dataDir,
      projectKey,
      agentId: 'base2-plan',
      mode: 'plan',
    })
    const planAllowed = (await host.dispatch('gitRevert', [
      { cwd: dataDir, file: 'README.md' },
    ])) as { code?: string }
    expect(planAllowed.code).not.toBe('project-busy')
    releaseRun(planRun.runId)
  })
})
