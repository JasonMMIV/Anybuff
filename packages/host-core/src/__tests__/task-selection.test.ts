import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHostEnv } from '../env'
import { createHost } from '../index'
import { ensureProjectTask, getTaskSelection, updateTaskSelection } from '../settings/settings'
import { noEncryptionSecrets } from './helpers'

const dataDir = mkdtempSync(join(tmpdir(), 'host-core-task-selection-'))
process.env.ANYBUFF_PROVIDER_CONFIG = join(dataDir, 'anybuff.json')

function install(): void {
  installHostEnv({
    paths: { dataDir, appDataDir: dataDir, homeDir: dataDir },
    secrets: noEncryptionSecrets(),
  })
}

afterAll(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

describe('task composer selection', () => {
  test('persists all three fields and merges partial updates', () => {
    install()
    const task = ensureProjectTask('/tmp/demo-project', 'hello')

    updateTaskSelection(task.id, {
      mode: 'plan',
      model: 'p1/model-a',
      reasoningEffort: 'high',
    })
    expect(getTaskSelection(task.id)).toEqual({
      mode: 'plan',
      model: 'p1/model-a',
      reasoningEffort: 'high',
    })

    updateTaskSelection(task.id, { model: 'p1/model-b' })
    expect(getTaskSelection(task.id)).toEqual({
      mode: 'plan',
      model: 'p1/model-b',
      reasoningEffort: 'high',
    })
  })

  test('ignores invalid modes and empty strings instead of erasing fields', () => {
    install()
    const task = ensureProjectTask('/tmp/demo-project-2', 'hello')

    updateTaskSelection(task.id, { mode: 'plan', model: 'p1/model-a' })
    updateTaskSelection(task.id, {
      mode: 'not-a-mode' as never,
      model: '   ',
      reasoningEffort: '',
    })

    expect(getTaskSelection(task.id)).toEqual({
      mode: 'plan',
      model: 'p1/model-a',
    })
  })

  test('returns undefined for an unknown task', () => {
    install()
    expect(getTaskSelection('missing-task')).toBeUndefined()
    expect(updateTaskSelection('missing-task', { mode: 'chat' })).toBeUndefined()
  })

  test('setTaskSelection channel persists and getTaskView returns it', async () => {
    install()
    const task = ensureProjectTask('/tmp/demo-project-3', 'hello')
    const host = createHost()
    const selection = {
      mode: 'chat' as const,
      model: 'p1/model-c',
      reasoningEffort: 'low',
    }

    const saved = await host.dispatch('setTaskSelection', [
      { taskId: task.id, selection },
    ])
    expect(saved).toMatchObject({ ok: true, selection })

    const view = await host.dispatch('getTaskView', [task.id])
    expect(view).toMatchObject({ ok: true, selection })
  })
})
