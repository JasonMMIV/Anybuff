/**
 * Task view context usage.
 *
 * The renderer's `/compact` confirmation gates on the context reading. That
 * reading is live-event-only everywhere else, so reopening a task used to show
 * 0/0 until the next run. `getSessionSnapshot` now surfaces the count that the
 * SDK already persists inside the run state — both from the live session and
 * from the on-disk run state after a restart.
 */

import { afterAll, describe, expect, test } from 'bun:test'

import { installHostEnv } from '../index'
import {
  dropSession,
  getOrCreateSession,
  getSession,
  getSessionSnapshot,
} from '../sessions/session-store'
import { saveTaskRunState } from '../settings/settings'
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

let seq = 0
function freshSession(): string {
  seq += 1
  const taskId = `task-view-usage-${seq}`
  getOrCreateSession('/tmp/task-view-usage-project', 'task view usage', taskId)
  return taskId
}

describe('getSessionSnapshot context usage', () => {
  test('reads contextTokenCount from the live run state', () => {
    const taskId = freshSession()
    const entry = getSession(taskId)
    expect(entry).toBeDefined()
    entry!.runState = {
      sessionState: { mainAgentState: { contextTokenCount: 12_345 } },
    }

    expect(getSessionSnapshot(taskId).contextTokenCount).toBe(12_345)
  })

  test('reads contextTokenCount from a persisted run state after a restart', () => {
    const taskId = freshSession()
    saveTaskRunState(taskId, {
      sessionState: { mainAgentState: { contextTokenCount: 4_321 } },
    })
    // Drop the in-memory entry so the snapshot takes the disk path.
    dropSession(taskId)

    expect(getSessionSnapshot(taskId).contextTokenCount).toBe(4_321)
  })

  test('omits a missing or non-numeric count', () => {
    const taskId = freshSession()
    const entry = getSession(taskId)!
    entry.runState = { sessionState: { mainAgentState: {} } }
    expect(getSessionSnapshot(taskId).contextTokenCount).toBeUndefined()

    entry.runState = {
      sessionState: { mainAgentState: { contextTokenCount: '12' } },
    }
    expect(getSessionSnapshot(taskId).contextTokenCount).toBeUndefined()
  })
})
