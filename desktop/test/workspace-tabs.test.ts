/**
 * Titlebar tab helpers — title truncation, draft reuse and close-neighbour
 * selection. Pure functions keep the tab state machine testable without a DOM
 * harness.
 */

import { describe, expect, test } from 'bun:test'
import {
  findDraftTab,
  makeTabId,
  neighborTabAfterClose,
  tabTitleFromPrompt,
  type WorkspaceTab,
} from '../src/renderer/src/utils/workspace-tabs'

const tab = (id: string, taskId: string | null, projectPath: string | null = '~/p'): WorkspaceTab => ({
  id,
  taskId,
  projectPath,
  title: taskId ? id : 'New chat',
})

describe('tabTitleFromPrompt', () => {
  test('empty / whitespace-only prompts use the fallback', () => {
    expect(tabTitleFromPrompt(undefined)).toBe('New chat')
    expect(tabTitleFromPrompt('   \n\t ')).toBe('New chat')
    expect(tabTitleFromPrompt('', 'Untitled')).toBe('Untitled')
  })

  test('collapses whitespace into a single line', () => {
    expect(tabTitleFromPrompt('  fix\n the\tbutton  ')).toBe('fix the button')
  })

  test('short prompts are untouched', () => {
    expect(tabTitleFromPrompt('add zero-division handling')).toBe('add zero-division handling')
  })

  test('caps long prompts at 72 characters with an ellipsis', () => {
    const title = tabTitleFromPrompt('a'.repeat(100))
    expect(title).toBe(`${'a'.repeat(71)}…`)
    expect(Array.from(title)).toHaveLength(72)
  })

  test('does not split surrogate pairs at the cap', () => {
    const title = tabTitleFromPrompt('😀'.repeat(80))
    expect(title).toBe(`${'😀'.repeat(71)}…`)
    expect(title.includes('\uFFFD')).toBe(false)
  })
})

describe('findDraftTab', () => {
  test('matches only empty drafts for the requested project', () => {
    const tabs = [tab('a', null), tab('b', 'task-1'), tab('c', null, '~/q')]
    expect(findDraftTab(tabs, '~/p')?.id).toBe('a')
    expect(findDraftTab(tabs, '~/q')?.id).toBe('c')
    expect(findDraftTab(tabs, '~/missing')).toBeUndefined()
  })

  test('a task tab never counts as a reusable draft', () => {
    expect(findDraftTab([tab('a', 'task-1')], '~/p')).toBeUndefined()
  })
})

describe('neighborTabAfterClose', () => {
  test('selects the tab that takes the closed slot', () => {
    const tabs = [tab('a', 't1'), tab('b', 't2'), tab('c', 't3')]
    expect(neighborTabAfterClose(tabs, 'b')?.id).toBe('c')
  })

  test('falls back to the previous tab when closing the last one', () => {
    const tabs = [tab('a', 't1'), tab('b', 't2')]
    expect(neighborTabAfterClose(tabs, 'b')?.id).toBe('a')
  })

  test('returns null when the last remaining tab is closed', () => {
    expect(neighborTabAfterClose([tab('a', 't1')], 'a')).toBeNull()
  })

  test('returns null for an unknown tab id', () => {
    expect(neighborTabAfterClose([tab('a', 't1')], 'missing')).toBeNull()
  })
})

describe('makeTabId', () => {
  test('is prefixed, deterministic from its inputs and collision-resistant', () => {
    const a = makeTabId(1_700_000_000_000, 0.123456789)
    const b = makeTabId(1_700_000_000_000, 0.987654321)
    expect(a.startsWith('tab-')).toBe(true)
    expect(a).toBe(makeTabId(1_700_000_000_000, 0.123456789))
    expect(a).not.toBe(b)
  })
})
