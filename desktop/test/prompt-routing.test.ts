import { describe, expect, it } from 'bun:test'
import { promptVisibleInActiveTab } from '../src/renderer/src/utils/prompt-routing'

describe('promptVisibleInActiveTab', () => {
  it('hides a missing prompt', () => {
    expect(promptVisibleInActiveTab(null, 'task-a', ['task-a'])).toBe(false)
    expect(promptVisibleInActiveTab(undefined, 'task-a', ['task-a'])).toBe(false)
  })

  it('keeps legacy prompts without a taskId visible', () => {
    expect(promptVisibleInActiveTab({}, 'task-a', ['task-a'])).toBe(true)
  })

  it('shows a prompt in its owning tab', () => {
    expect(
      promptVisibleInActiveTab({ taskId: 'task-a' }, 'task-a', ['task-a', 'task-b'])
    ).toBe(true)
  })

  it('hides a prompt while another open tab is active', () => {
    expect(
      promptVisibleInActiveTab({ taskId: 'task-a' }, 'task-b', ['task-a', 'task-b'])
    ).toBe(false)
  })

  it('hides a background prompt from a draft tab', () => {
    expect(promptVisibleInActiveTab({ taskId: 'task-a' }, null, ['task-a'])).toBe(false)
  })

  it('falls back to the active tab when the owning tab was closed', () => {
    expect(promptVisibleInActiveTab({ taskId: 'task-a' }, 'task-b', ['task-b'])).toBe(true)
    expect(promptVisibleInActiveTab({ taskId: 'task-a' }, null, [])).toBe(true)
  })
})
