import { describe, expect, test } from 'bun:test'
import {
  clampTabReasoningEffort,
  DEFAULT_TAB_SELECTION,
  isTabMode,
  mergeTabSelection,
  resolveTabSelection,
  sameTabSelection,
} from '../src/renderer/src/utils/tab-selection'

describe('resolveTabSelection', () => {
  test('uses the fallback for an empty tab selection', () => {
    expect(resolveTabSelection(undefined, { mode: 'plan', model: 'openai/gpt-5.5', reasoningEffort: 'high' })).toEqual({
      mode: 'plan',
      model: 'openai/gpt-5.5',
      reasoningEffort: 'high',
    })
  })

  test('keeps valid partial fields and trims strings', () => {
    expect(
      resolveTabSelection(
        { mode: 'chat', model: ' anthropic/claude-sonnet-4-5 ', reasoningEffort: ' medium ' },
        DEFAULT_TAB_SELECTION
      )
    ).toEqual({
      mode: 'chat',
      model: 'anthropic/claude-sonnet-4-5',
      reasoningEffort: 'medium',
    })
  })

  test('rejects an invalid persisted mode', () => {
    expect(resolveTabSelection({ mode: 'nope' as never }, DEFAULT_TAB_SELECTION).mode).toBe('default')
  })
})

describe('mergeTabSelection', () => {
  test('changing a model leaves the mode and reasoning effort intact', () => {
    expect(
      mergeTabSelection(
        { mode: 'plan', model: 'openai/a', reasoningEffort: 'high' },
        DEFAULT_TAB_SELECTION,
        { model: 'openai/b' }
      )
    ).toEqual({ mode: 'plan', model: 'openai/b', reasoningEffort: 'high' })
  })

  test('two tabs can hold different selections', () => {
    const fallback = { ...DEFAULT_TAB_SELECTION, model: 'openai/default' }
    const a = mergeTabSelection(undefined, fallback, { mode: 'plan', model: 'openai/a', reasoningEffort: 'high' })
    const b = mergeTabSelection(undefined, fallback, { mode: 'chat', model: 'anthropic/b' })
    expect(a).toEqual({ mode: 'plan', model: 'openai/a', reasoningEffort: 'high' })
    expect(b).toEqual({ mode: 'chat', model: 'anthropic/b', reasoningEffort: 'default' })
    expect(sameTabSelection(a, b)).toBe(false)
  })
})

describe('clampTabReasoningEffort', () => {
  test('keeps a rung that the model supports', () => {
    const selection = { mode: 'default' as const, model: 'p/m', reasoningEffort: 'high' }
    expect(clampTabReasoningEffort(selection, ['default', 'low', 'high'])).toEqual(selection)
  })

  test('falls back to default when the new model has no such rung', () => {
    const selection = { mode: 'default' as const, model: 'p/m', reasoningEffort: 'xhigh' }
    expect(clampTabReasoningEffort(selection, ['default', 'low', 'high'])).toEqual({
      ...selection,
      reasoningEffort: 'default',
    })
  })
})

describe('isTabMode', () => {
  test('accepts only the three UI modes', () => {
    expect(['default', 'plan', 'chat'].every(isTabMode)).toBe(true)
    expect(isTabMode('build')).toBe(false)
  })
})
