import { describe, expect, test } from 'bun:test'
import {
  addTaskId,
  dropTaskValue,
  isStaleTerminalRun,
  removeTaskId,
  setTaskValue,
  taskValue,
} from '../src/renderer/src/utils/run-state'

describe('per-task run state helpers', () => {
  test('add/remove keep the same reference when nothing changes', () => {
    const ids = new Set(['a'])
    expect(addTaskId(ids, null)).toBe(ids)
    expect(addTaskId(ids, 'a')).toBe(ids)
    expect(removeTaskId(ids, 'b')).toBe(ids)
    expect(removeTaskId(ids, 'a')).not.toBe(ids)
    expect([...removeTaskId(ids, 'a')]).toEqual([])
  })

  test('adding a second task leaves the first one running', () => {
    const ids = addTaskId(addTaskId(new Set<string>(), 'a'), 'b')
    expect([...ids].sort()).toEqual(['a', 'b'])
    expect([...removeTaskId(ids, 'a')]).toEqual(['b'])
  })

  test('task records are updated and dropped immutably', () => {
    const empty: Record<string, string> = {}
    const one = setTaskValue(empty, 'a', 'done')
    expect(empty).toEqual({})
    expect(one).toEqual({ a: 'done' })
    expect(setTaskValue(one, 'a', 'done')).toBe(one)
    expect(setTaskValue(one, 'b', 'error')).toEqual({ a: 'done', b: 'error' })
    expect(dropTaskValue(one, 'missing')).toBe(one)
    expect(dropTaskValue(one, 'a')).toEqual({})
  })

  test('taskValue only reads an exact task id', () => {
    const values = { a: 'done' }
    expect(taskValue(values, 'a')).toBe('done')
    expect(taskValue(values, 'b')).toBeUndefined()
    expect(taskValue(values, null)).toBeUndefined()
  })

  test('a terminal event from a replaced run is stale', () => {
    expect(isStaleTerminalRun('run-new', 'run-old')).toBe(true)
    expect(isStaleTerminalRun('run-new', 'run-new')).toBe(false)
    // Legacy hosts omit runId; still apply the terminal.
    expect(isStaleTerminalRun('run-new', undefined)).toBe(false)
    expect(isStaleTerminalRun(undefined, 'run-old')).toBe(false)
  })
})
