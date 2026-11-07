import { afterEach, describe, expect, test } from 'bun:test'
import {
  __resetInteractiveQueueForTests,
  dropPromptsForRun,
  enqueuePrompt,
  headPrompt,
  pendingPromptCount,
  resolveHeadPrompt,
  resolvePrompt,
  resolvePromptFor,
  setInteractivePromptEmitter,
  type InteractivePrompt,
} from '../run/interactive-queue'

let emitted: string[] = []

function installEmitter(): void {
  emitted = []
  setInteractivePromptEmitter((prompt) => {
    emitted.push(prompt.promptId)
  })
}

function queuePrompt(
  kind: 'approval' | 'ask_user',
  runId: string,
  taskId: string,
  title = taskId
): Promise<unknown> {
  return enqueuePrompt({ kind, runId, taskId, title, payload: { kind } })
}

afterEach(() => {
  __resetInteractiveQueueForTests()
})

describe('interactive prompt FIFO', () => {
  test('emits only the head and advances after it settles', async () => {
    installEmitter()
    const a = queuePrompt('approval', 'run-a', 'task-a')
    const b = queuePrompt('ask_user', 'run-b', 'task-b')

    const head = headPrompt()
    expect(head?.promptId).toBe(emitted[0]!)
    expect(emitted).toHaveLength(1)
    expect(pendingPromptCount()).toBe(2)

    expect(resolvePrompt(head!.promptId, true)).toBe(true)
    await expect(a).resolves.toBe(true)
    expect(emitted).toHaveLength(2)
    expect(headPrompt()?.promptId).toBe(emitted[1]!)

    expect(resolvePrompt(emitted[1]!, { answer: 1 })).toBe(true)
    await expect(b).resolves.toEqual({ answer: 1 })
    expect(pendingPromptCount()).toBe(0)
  })

  test('only the head can be resolved', async () => {
    installEmitter()
    const a = queuePrompt('approval', 'run-a', 'task-a')
    const b = queuePrompt('approval', 'run-b', 'task-b')

    const secondId = emitted[1]
    // Not emitted yet — no id to target, so prove via headPrompt.
    expect(secondId).toBeUndefined()
    expect(headPrompt()?.taskId).toBe('task-a')
    expect(resolvePrompt('prompt-missing', true)).toBe(false)
    expect(pendingPromptCount()).toBe(2)

    expect(resolvePrompt(emitted[0]!, true)).toBe(true)
    await expect(a).resolves.toBe(true)
    expect(headPrompt()?.taskId).toBe('task-b')
    expect(resolvePrompt(emitted[1]!, false)).toBe(true)
    await expect(b).resolves.toBe(false)
  })

  test('legacy kind resolution settles only a matching head', async () => {
    installEmitter()
    const a = queuePrompt('ask_user', 'run-a', 'task-a')
    expect(resolveHeadPrompt('approval', true)).toBe(false)
    expect(resolveHeadPrompt('ask_user', { skipped: true })).toBe(true)
    await expect(a).resolves.toEqual({ skipped: true })
  })

  test('targeted resolution matches promptId/taskId/runId on the head', async () => {
    installEmitter()
    const a = queuePrompt('approval', 'run-a', 'task-a')
    const head = headPrompt()!

    expect(resolvePromptFor('approval', { taskId: 'task-b' }, true)).toBe(false)
    expect(resolvePromptFor('approval', { runId: 'run-b' }, true)).toBe(false)
    expect(resolvePromptFor('approval', { promptId: 'prompt-other' }, true)).toBe(false)
    expect(resolvePromptFor('approval', { taskId: 'task-a', runId: 'run-a' }, true)).toBe(true)
    await expect(a).resolves.toBe(true)
    expect(pendingPromptCount()).toBe(0)
    expect(headPrompt()).toBeUndefined()
  })

  test('dropping a run settles its prompts without resolving another owner', async () => {
    installEmitter()
    const a = queuePrompt('approval', 'run-a', 'task-a')
    const b = queuePrompt('ask_user', 'run-b', 'task-b')

    expect(resolvePrompt(headPrompt()!.promptId, true)).toBe(true)
    await expect(a).resolves.toBe(true)
    expect(headPrompt()?.taskId).toBe('task-b')

    dropPromptsForRun('run-b')
    await expect(b).resolves.toEqual({ skipped: true })
    expect(pendingPromptCount()).toBe(0)
  })

  test('dropping the head promotes the next queued prompt', async () => {
    installEmitter()
    const a = queuePrompt('approval', 'run-a', 'task-a')
    const b = queuePrompt('approval', 'run-b', 'task-b')

    dropPromptsForRun('run-a')
    await expect(a).resolves.toBe(false)
    expect(emitted).toHaveLength(2)
    expect(headPrompt()?.taskId).toBe('task-b')

    dropPromptsForRun('run-b')
    await expect(b).resolves.toBe(false)
    expect(pendingPromptCount()).toBe(0)
  })
})
