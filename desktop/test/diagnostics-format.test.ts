import { describe, expect, test } from 'bun:test'
import {
  formatRunDuration,
  projectBasename,
  runModeLabel,
  shortTaskId,
} from '../src/renderer/src/utils/diagnostics-format'

describe('shortTaskId', () => {
  test('keeps short ids intact', () => {
    expect(shortTaskId('task_123')).toBe('task_123')
  })

  test('truncates long ids to the first eight characters', () => {
    expect(shortTaskId('task_0123456789abcdef')).toBe('task_012…')
  })

  test('renders an em dash for missing ids', () => {
    expect(shortTaskId('')).toBe('—')
    expect(shortTaskId('   ')).toBe('—')
  })
})

describe('runModeLabel', () => {
  test('maps internal modes to UI labels', () => {
    expect(runModeLabel('default')).toBe('Build')
    expect(runModeLabel('plan')).toBe('Plan')
    expect(runModeLabel('chat')).toBe('Chat')
  })

  test('falls back to unknown mode strings', () => {
    expect(runModeLabel('future-mode')).toBe('future-mode')
  })
})

describe('projectBasename', () => {
  test('handles Windows and POSIX paths', () => {
    expect(projectBasename('C:\\Users\\alice\\demo-project')).toBe('demo-project')
    expect(projectBasename('/home/alice/demo-project')).toBe('demo-project')
  })

  test('ignores trailing separators and double separators', () => {
    expect(projectBasename('C:\\Users\\alice\\demo-project\\')).toBe('demo-project')
    expect(projectBasename('/home//alice//demo-project/')).toBe('demo-project')
  })

  test('renders an em dash for an empty path', () => {
    expect(projectBasename('')).toBe('—')
    expect(projectBasename('/')).toBe('—')
  })
})

describe('formatRunDuration', () => {
  const startedAt = 1_700_000_000_000

  test('shows sub-second runs without rounding down to zero', () => {
    expect(formatRunDuration(startedAt, startedAt + 250)).toBe('<1s')
  })

  test('shows seconds under a minute', () => {
    expect(formatRunDuration(startedAt, startedAt + 12_000)).toBe('12s')
  })

  test('shows minutes with zero-padded seconds', () => {
    expect(formatRunDuration(startedAt, startedAt + 65_000)).toBe('1m 05s')
  })

  test('shows hours and minutes past an hour', () => {
    expect(formatRunDuration(startedAt, startedAt + 3_725_000)).toBe('1h 02m')
  })

  test('clamps clock skew and rejects invalid timestamps', () => {
    expect(formatRunDuration(startedAt, startedAt - 500)).toBe('<1s')
    expect(formatRunDuration(0, startedAt)).toBe('—')
    expect(formatRunDuration(Number.NaN, startedAt)).toBe('—')
  })
})
