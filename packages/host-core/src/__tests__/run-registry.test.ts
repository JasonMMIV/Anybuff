import { afterEach, describe, expect, test } from 'bun:test'
import {
  __resetRunRegistryForTests,
  countRuns,
  createRun,
  getRun,
  getRunByTaskId,
  listRuns,
  releaseRun,
} from '../run/run-registry'

function makeRun(taskId: string, projectKey = '/repo/a') {
  return createRun({
    taskId,
    cwd: projectKey,
    projectKey,
    agentId: 'base2',
    mode: 'default',
  })
}

afterEach(() => {
  __resetRunRegistryForTests()
})

describe('run registry lifecycle', () => {
  test('registers, indexes and releases runs', () => {
    const a = makeRun('task-a')
    const b = makeRun('task-b', '/repo/b')

    expect(countRuns()).toBe(2)
    expect(listRuns().map((run) => run.taskId)).toEqual(['task-a', 'task-b'])
    expect(getRun(a.runId)?.taskId).toBe('task-a')
    expect(getRunByTaskId('task-b')?.runId).toBe(b.runId)
    expect(getRunByTaskId('missing')).toBeUndefined()

    releaseRun(a.runId)
    expect(countRuns()).toBe(1)
    expect(getRun(a.runId)).toBeUndefined()
    expect(getRunByTaskId('task-a')).toBeUndefined()
  })

  test('release is idempotent and safely ignores unknown runs', () => {
    const run = makeRun('task-a')
    releaseRun(run.runId)
    releaseRun(run.runId)
    releaseRun('run-missing')
    expect(countRuns()).toBe(0)
  })

  test('multiple runs may share one project', () => {
    const a = makeRun('task-a', '/repo/a')
    const b = makeRun('task-b', '/repo/a')
    expect(countRuns()).toBe(2)
    expect(listRuns().filter((run) => run.projectKey === '/repo/a')).toHaveLength(2)
    releaseRun(a.runId)
    releaseRun(b.runId)
    expect(countRuns()).toBe(0)
  })
})
