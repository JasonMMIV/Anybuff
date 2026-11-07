import { describe, expect, test } from 'bun:test'
import {
  terminalRunBody,
  terminalRunHeading,
  terminalRunKey,
} from '../src/renderer/src/utils/run-notifications'

describe('terminalRunKey', () => {
  test('returns null for non-terminal states', () => {
    expect(terminalRunKey({ runId: 'run-a', status: 'running' })).toBeNull()
    expect(terminalRunKey({ runId: 'run-a', status: 'auto_retry' })).toBeNull()
    expect(terminalRunKey({ runId: 'run-a' })).toBeNull()
  })

  test('dedupes by run id and terminal status', () => {
    expect(terminalRunKey({ runId: 'run-a', taskId: 'task-a', status: 'idle' })).toBe('run-a:idle')
    expect(terminalRunKey({ runId: 'run-a', taskId: 'task-a', status: 'interrupted' })).toBe(
      'run-a:interrupted'
    )
    expect(terminalRunKey({ runId: 'run-b', taskId: 'task-a', status: 'idle' })).toBe('run-b:idle')
  })

  test('falls back to task id for legacy hosts', () => {
    expect(terminalRunKey({ taskId: 'task-a', status: 'idle' })).toBe('task-a:idle')
    expect(terminalRunKey({ status: 'idle' })).toBeNull()
  })
})

describe('terminalRun copy', () => {
  test('names the conversation when available', () => {
    expect(terminalRunBody('Fix login', 'idle')).toBe('Fix login finished.')
    expect(terminalRunBody('Fix login', 'interrupted')).toContain('needs attention')
    expect(terminalRunBody(undefined, 'idle')).toBe('Task finished.')
  })

  test('uses a short status heading', () => {
    expect(terminalRunHeading('idle')).toBe('Run finished')
    expect(terminalRunHeading('interrupted')).toBe('Run interrupted')
  })
})
