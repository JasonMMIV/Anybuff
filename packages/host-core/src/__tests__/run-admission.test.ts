import { describe, expect, test } from 'bun:test'
import { resolveRunAdmission } from '../run/admission'

const runs = [{ taskId: 'task-a' }, { taskId: 'task-b' }]

describe('resolveRunAdmission (task-only policy)', () => {
  test('admits a different task in any project', () => {
    expect(resolveRunAdmission({ taskId: 'task-c', runs })).toEqual({ ok: true })
  })

  test('admits a different task in the SAME project', () => {
    // Build + Plan on the same working tree is an explicit user-supported
    // scenario; project concurrency is not part of admission.
    expect(resolveRunAdmission({ taskId: 'task-c', runs: [{ taskId: 'task-a' }] })).toEqual({ ok: true })
  })

  test('rejects a second run for the same task', () => {
    expect(resolveRunAdmission({ taskId: 'task-a', runs })).toEqual({
      ok: false,
      code: 'task-busy',
      runningTaskId: 'task-a',
    })
  })

  test('a new task (no taskId) is always admitted', () => {
    expect(resolveRunAdmission({ runs })).toEqual({ ok: true })
  })

  test('an empty registry admits any task', () => {
    expect(resolveRunAdmission({ taskId: 'task-a', runs: [] })).toEqual({ ok: true })
  })
})
