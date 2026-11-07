import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  __resetRunRegistryForTests,
  __resetSteeringForTests,
  activateSteering,
  createHost,
  createRun,
  deactivateSteering,
  drainSteeringMessages,
  finishRun,
  getOrCreateSession,
  installHostEnv,
  listRuns,
  markRunning,
  releaseRun,
  resolveProjectKey,
  resolveRunAdmission,
} from '../index'
import { abortRunChannel, sendNowChannel } from '../channels/handlers-runs'
import { noEncryptionSecrets } from './helpers'

const dataDir = mkdtempSync(join(tmpdir(), 'host-core-targeting-'))
let host: ReturnType<typeof createHost>

beforeAll(() => {
  installHostEnv({
    paths: { dataDir, appDataDir: dataDir, homeDir: dataDir },
    secrets: noEncryptionSecrets(),
  })
  host = createHost()
})

afterEach(() => {
  __resetRunRegistryForTests()
  __resetSteeringForTests()
})

function newRun(taskId: string, projectKey: string) {
  return createRun({
    taskId,
    cwd: projectKey,
    projectKey,
    agentId: 'base2',
    mode: 'default',
  })
}

describe('runPrompt admission', () => {
  test('returns task-busy before creating a session; same-project tasks are admitted', async () => {
    const projectKey = await resolveProjectKey(dataDir)
    const busy = newRun('busy-task', projectKey)
    const configPath = join(dataDir, 'anybuff.json')
    writeFileSync(configPath, '{"sentinel":true}', 'utf8')

    const taskBusy = (await host.dispatch('runPrompt', [
      { cwd: dataDir, prompt: 'hello', taskId: 'busy-task' },
    ])) as { ok: false; code?: string; runningTaskId?: string }
    expect(taskBusy.ok).toBe(false)
    expect(taskBusy.code).toBe('task-busy')
    expect(taskBusy.runningTaskId).toBe('busy-task')
    // Rejected admission must not rewrite the provider config.
    expect(readFileSync(configPath, 'utf8')).toBe('{"sentinel":true}')

    // The old per-project rejection is gone: a different task in the same
    // project is admitted. (Do not dispatch another runPrompt here — that
    // would start a real SDK run.)
    expect(resolveRunAdmission({ taskId: 'other-task', runs: listRuns() })).toEqual({ ok: true })
    releaseRun(busy.runId)
  })
})

describe('getState / diagnostics running sets', () => {
  test('exposes runningTaskIds and the active run list', async () => {
    const taskId = getOrCreateSession(dataDir, 'running state', 'running-state-task').taskId
    const run = newRun(taskId, await resolveProjectKey(dataDir))
    markRunning(taskId)

    const state = (await host.dispatch('getState', [])) as {
      ok: true
      result: { running: boolean; runningTaskId: string | null; runningTaskIds: string[] }
    }
    expect(state.result.running).toBe(true)
    expect(state.result.runningTaskId).toBe(taskId)
    expect(state.result.runningTaskIds).toContain(taskId)

    const diagnostics = (await host.dispatch('getDiagnostics', [])) as {
      ok: true
      result: { runs: Array<{ taskId: string; runId: string }> }
    }
    expect(diagnostics.result.runs.some((item) => item.taskId === taskId)).toBe(true)

    finishRun(taskId, null, { interrupted: false })
    releaseRun(run.runId)
  })
})

describe('targeted steering and abort', () => {
  test('sendNow routes to the addressed run only', () => {
    const a = getOrCreateSession('/tmp/target-a', 'A', 'target-a').taskId
    const b = getOrCreateSession('/tmp/target-b', 'B', 'target-b').taskId
    const runA = newRun(a, '/tmp/target-a')
    const runB = newRun(b, '/tmp/target-b')
    activateSteering(runA.runId)
    activateSteering(runB.runId)

    const res = sendNowChannel({ text: 'to b', taskId: b }) as {
      ok: boolean
      pushId?: string
    }
    expect(res.ok).toBe(true)
    expect(drainSteeringMessages(runA.runId)).toEqual([])
    expect(drainSteeringMessages(runB.runId)).toEqual(['to b'])
    const echo = getOrCreateSession('/tmp/target-b', 'B', b).transcript.find(
      (item) => item.kind === 'user' && item.steeringId === res.pushId
    )
    expect(echo?.text).toBe('to b')

    expect(abortRunChannel({ taskId: b })).toEqual({ ok: true })
    expect(runB.abort.signal.aborted).toBe(true)
    expect(runA.abort.signal.aborted).toBe(false)

    // Two registered runs remain (the aborted one is released by its own
    // finally in production); no-target abort must refuse to guess.
    expect(listRuns()).toHaveLength(2)
    expect(abortRunChannel()).toMatchObject({ ok: false, code: 'ambiguous-target' })

    releaseRun(runB.runId)
    deactivateSteering(runB.runId)
    expect(abortRunChannel({ runId: runA.runId })).toEqual({ ok: true })
    expect(runA.abort.signal.aborted).toBe(true)
    releaseRun(runA.runId)
    deactivateSteering(runA.runId)
  })
})
