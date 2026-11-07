/**
 * Titlebar tab helpers — title truncation, draft reuse and close-neighbour
 * selection. Pure functions keep the tab state machine testable without a DOM
 * harness.
 */

import { describe, expect, test } from 'bun:test'
import {
  findDraftTab,
  makeTabId,
  moveWorkspaceTab,
  neighborTabAfterClose,
  projectInitial,
  retargetDraftTab,
  tabTitleFromPrompt,
  type WorkspaceTab,
} from '../src/renderer/src/utils/workspace-tabs'

const tab = (id: string, taskId: string | null, projectPath: string | null = '~/p'): WorkspaceTab => ({
  id,
  taskId,
  projectPath,
  title: taskId ? id : 'New Task',
})

describe('tabTitleFromPrompt', () => {
  test('empty / whitespace-only prompts use the fallback', () => {
    expect(tabTitleFromPrompt(undefined)).toBe('New Task')
    expect(tabTitleFromPrompt('   \n\t ')).toBe('New Task')
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

describe('retargetDraftTab', () => {
  test('moves a draft tab to another project in place and leaves the others alone', () => {
    const tabs = [tab('a', null), tab('b', 'task-1')]
    const next = retargetDraftTab(tabs, 'a', '~/q')
    expect(next).not.toBeNull()
    expect(next?.[0]).toMatchObject({ id: 'a', taskId: null, projectPath: '~/q' })
    expect(next?.[1]).toEqual(tabs[1])
    // Pure: the input list is never mutated.
    expect(tabs[0].projectPath).toBe('~/p')
    expect(next).not.toBe(tabs)
  })

  test('refuses a task tab (its host conversation owns the project)', () => {
    expect(retargetDraftTab([tab('b', 'task-1')], 'b', '~/q')).toBeNull()
  })

  test('refuses a missing or absent active tab', () => {
    expect(retargetDraftTab([tab('a', null)], null, '~/q')).toBeNull()
    expect(retargetDraftTab([tab('a', null)], 'missing', '~/q')).toBeNull()
  })

  test('keeps a null project path retargetable (folder not picked yet)', () => {
    const next = retargetDraftTab([tab('a', null, null)], 'a', '~/q')
    expect(next?.[0].projectPath).toBe('~/q')
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

describe('moveWorkspaceTab', () => {
  const ids = (tabs: readonly WorkspaceTab[] | null) => tabs?.map((item) => item.id)

  test('moves a left tab to the right of its target', () => {
    const tabs = [tab('a', 't1'), tab('b', 't2'), tab('c', 't3')]
    expect(ids(moveWorkspaceTab(tabs, 'a', 'b', 'after'))).toEqual(['b', 'a', 'c'])
  })

  test('moves a right tab to the left of its target', () => {
    const tabs = [tab('a', 't1'), tab('b', 't2'), tab('c', 't3')]
    expect(ids(moveWorkspaceTab(tabs, 'c', 'b', 'before'))).toEqual(['a', 'c', 'b'])
  })

  test('dropping next to itself is a no-op', () => {
    const tabs = [tab('a', 't1'), tab('b', 't2')]
    expect(moveWorkspaceTab(tabs, 'a', 'a', 'after')).toBeNull()
    expect(moveWorkspaceTab(tabs, 'a', 'b', 'before')).toBeNull()
    expect(moveWorkspaceTab(tabs, 'b', 'a', 'after')).toBeNull()
  })

  test('unknown ids are ignored', () => {
    const tabs = [tab('a', 't1')]
    expect(moveWorkspaceTab(tabs, 'missing', 'a', 'after')).toBeNull()
    expect(moveWorkspaceTab(tabs, 'a', 'missing', 'before')).toBeNull()
  })

  test('never mutates the input order', () => {
    const tabs = [tab('a', 't1'), tab('b', 't2'), tab('c', 't3')]
    moveWorkspaceTab(tabs, 'c', 'a', 'before')
    expect(tabs.map((item) => item.id)).toEqual(['a', 'b', 'c'])
  })

  test('keeps the moved tab object (task/project metadata) intact', () => {
    const tabs = [tab('a', 't1'), tab('b', 't2')]
    const moved = moveWorkspaceTab(tabs, 'a', 'b', 'after')
    expect(moved?.[1]).toBe(tabs[0])
    expect(moved?.[1]).toMatchObject({ taskId: 't1', projectPath: '~/p' })
  })
})

describe('projectInitial', () => {
  test('uses the folder name on POSIX and Windows paths', () => {
    expect(projectInitial('/home/me/AnyBuff')).toBe('A')
    expect(projectInitial('C:\\Users\\me\\AnyBuff')).toBe('A')
  })

  test('ignores trailing separators and handles drive roots', () => {
    expect(projectInitial('/home/me/AnyBuff/')).toBe('A')
    expect(projectInitial('C:\\')).toBe('C')
  })

  test('skips leading dots so dotfolders still show a letter', () => {
    expect(projectInitial('/home/me/.config')).toBe('C')
  })

  test('uses a leading digit and falls back for punctuation-only names', () => {
    expect(projectInitial('/work/2024-plans')).toBe('2')
    expect(projectInitial('/work/...')).toBe('?')
  })

  test('handles non-Latin names and a missing project', () => {
    expect(projectInitial('/home/me/專案')).toBe('專')
    expect(projectInitial(null)).toBe('?')
    expect(projectInitial('')).toBe('?')
  })
})
