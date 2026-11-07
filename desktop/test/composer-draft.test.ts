/**
 * Per-tab composer drafts — caret/selection clamping and the empty-draft rule.
 * Pure functions keep the tab-switch policy testable without a DOM harness.
 */

import { describe, expect, test } from 'bun:test'
import {
  EMPTY_COMPOSER_DRAFT,
  clampComposerSelection,
  composerDraftKey,
  createComposerDraft,
  isComposerTextEmpty,
} from '../src/renderer/src/utils/composer-draft'

describe('createComposerDraft', () => {
  test('defaults the caret to the end of the text', () => {
    expect(createComposerDraft('hello')).toEqual({
      text: 'hello',
      selectionStart: 5,
      selectionEnd: 5,
      scrollTop: 0,
    })
  })

  test('round-trips an explicit selection and scroll offset', () => {
    expect(createComposerDraft('hello', 1, 3, 42)).toEqual({
      text: 'hello',
      selectionStart: 1,
      selectionEnd: 3,
      scrollTop: 42,
    })
  })

  test('clamps out-of-range and inverted selections', () => {
    expect(createComposerDraft('abc', 99, 120)).toEqual({
      text: 'abc',
      selectionStart: 3,
      selectionEnd: 3,
      scrollTop: 0,
    })
    expect(createComposerDraft('abc', 2, 1)).toEqual({
      text: 'abc',
      selectionStart: 2,
      selectionEnd: 2,
      scrollTop: 0,
    })
    expect(createComposerDraft('abc', -5, -1)).toEqual({
      text: 'abc',
      selectionStart: 0,
      selectionEnd: 0,
      scrollTop: 0,
    })
  })

  test('never emits a negative scroll offset', () => {
    expect(createComposerDraft('abc', 0, 0, -20).scrollTop).toBe(0)
  })
})

describe('clampComposerSelection', () => {
  test('keeps a valid selection untouched', () => {
    expect(clampComposerSelection('abcdef', 2, 4)).toEqual({ start: 2, end: 4 })
  })

  test('a collapsed caret stays collapsed', () => {
    expect(clampComposerSelection('abcdef', 3, 3)).toEqual({ start: 3, end: 3 })
  })

  test('non-finite values fall back to the end', () => {
    const { start, end } = clampComposerSelection('abcd', Number.NaN, Number.POSITIVE_INFINITY)
    expect(start).toBe(4)
    expect(end).toBe(4)
  })

  test('end is pulled up to start when inverted', () => {
    expect(clampComposerSelection('abcd', 3, 1)).toEqual({ start: 3, end: 3 })
  })
})

describe('isComposerTextEmpty', () => {
  test('only empty text is empty; whitespace still counts as content', () => {
    expect(isComposerTextEmpty(EMPTY_COMPOSER_DRAFT.text)).toBe(true)
    expect(isComposerTextEmpty(undefined)).toBe(true)
    expect(isComposerTextEmpty(null)).toBe(true)
    expect(isComposerTextEmpty('')).toBe(true)
    expect(isComposerTextEmpty(' ')).toBe(false)
    expect(isComposerTextEmpty('hi')).toBe(false)
  })
})

describe('composerDraftKey', () => {
  const base = { activeViewTaskId: null, activeTabId: 'tab-1', cwd: '~/p', isAndroidShell: false }

  test('a task view owns the key', () => {
    expect(composerDraftKey({ ...base, activeViewTaskId: 'task-9' })).toBe('task-9')
  })

  test('desktop falls back to the tab, so two drafts in one project stay separate', () => {
    expect(composerDraftKey(base)).toBe('tab:tab-1')
  })

  test('Android ignores tabs and keeps the project-scoped bucket', () => {
    expect(composerDraftKey({ ...base, isAndroidShell: true })).toBe('__new__:~/p')
  })

  test('no tab falls back to the project bucket', () => {
    expect(composerDraftKey({ ...base, activeTabId: null })).toBe('__new__:~/p')
    expect(composerDraftKey({ ...base, activeTabId: null, cwd: null })).toBe('__new__:')
  })
})
