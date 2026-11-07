import { afterAll, describe, expect, test } from 'bun:test'
import { installHostEnv } from '../index'
import {
  dropSession,
  finishRun,
  getOrCreateSession,
  getRunningTaskId,
  getRunningTaskIds,
  hasActiveRun,
  isTaskRunning,
  markRunning,
} from '../sessions/session-store'
import { makeTestEnv, noEncryptionSecrets } from './helpers'

const env = makeTestEnv()

installHostEnv({
  paths: {
    dataDir: env.dataDir,
    appDataDir: env.dataDir,
    homeDir: env.dataDir,
  },
  secrets: noEncryptionSecrets(),
})

afterAll(() => {
  env.cleanup()
})

describe('session-store running set', () => {
  test('marks and finishes only the addressed task', () => {
    const a = getOrCreateSession('/tmp/running-set-a', 'task a', 'running-set-a').taskId
    const b = getOrCreateSession('/tmp/running-set-b', 'task b', 'running-set-b').taskId

    markRunning(a)
    expect(isTaskRunning(a)).toBe(true)
    expect(isTaskRunning(b)).toBe(false)
    expect(getRunningTaskId()).toBe(a)
    expect(getRunningTaskIds()).toEqual([a])
    expect(hasActiveRun()).toBe(true)

    markRunning(b)
    expect(getRunningTaskIds().sort()).toEqual([a, b].sort())
    // Compatibility view: no single "the" run when two are active.
    expect(getRunningTaskId()).toBeNull()

    finishRun(a, null, { interrupted: false })
    expect(isTaskRunning(a)).toBe(false)
    expect(isTaskRunning(b)).toBe(true)
    expect(getRunningTaskId()).toBe(b)

    finishRun(b, null, { interrupted: true })
    expect(hasActiveRun()).toBe(false)
    expect(getRunningTaskIds()).toEqual([])
    expect(getRunningTaskId()).toBeNull()
  })

  test('dropSession refuses only the task with an active run', () => {
    const running = getOrCreateSession('/tmp/running-set-c', 'running', 'running-set-c').taskId
    const idle = getOrCreateSession('/tmp/running-set-d', 'idle', 'running-set-d').taskId

    markRunning(running)
    expect(dropSession(running)).toBe(false)
    expect(dropSession(idle)).toBe(true)

    finishRun(running, null, { interrupted: true })
    expect(dropSession(running)).toBe(true)
  })
})
