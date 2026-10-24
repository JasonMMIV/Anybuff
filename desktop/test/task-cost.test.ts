/**
 * Per-task cost: finish.totalCost is CREDITS (cents) per run, so a
 * conversation's cost is the sum of its runs — never a global accumulator.
 */

import { describe, expect, test } from 'bun:test'
import {
  addTaskCost,
  removeTaskCost,
  taskCostUsd,
  type TaskCostMap,
} from '../src/renderer/src/utils/task-cost'

describe('addTaskCost', () => {
  test('sums runs of the same task', () => {
    let costs: TaskCostMap = {}
    costs = addTaskCost(costs, 'a', 1)
    costs = addTaskCost(costs, 'a', 3)
    expect(costs).toEqual({ a: 4 })
  })

  test('keeps tasks isolated', () => {
    let costs: TaskCostMap = {}
    costs = addTaskCost(costs, 'a', 2)
    costs = addTaskCost(costs, 'b', 7)
    expect(costs).toEqual({ a: 2, b: 7 })
  })

  test('ignores missing task ids, zero, negative and non-finite values', () => {
    const base: TaskCostMap = { a: 1 }
    expect(addTaskCost(base, undefined, 5)).toBe(base)
    expect(addTaskCost(base, '', 5)).toBe(base)
    expect(addTaskCost(base, 'a', 0)).toBe(base)
    expect(addTaskCost(base, 'a', -2)).toBe(base)
    expect(addTaskCost(base, 'a', Number.NaN)).toBe(base)
  })
})

describe('removeTaskCost', () => {
  test('drops only the deleted task', () => {
    expect(removeTaskCost({ a: 1, b: 2 }, 'a')).toEqual({ b: 2 })
  })

  test('returns the same object when the task is absent', () => {
    const costs: TaskCostMap = { a: 1 }
    expect(removeTaskCost(costs, 'b')).toBe(costs)
  })
})

describe('taskCostUsd', () => {
  test('converts credits (cents) to dollars', () => {
    expect(taskCostUsd({ a: 4 }, 'a')).toBe(0.04)
    expect(taskCostUsd({ a: 125 }, 'a')).toBe(1.25)
  })

  test('is zero for no/unknown task', () => {
    expect(taskCostUsd({ a: 4 }, null)).toBe(0)
    expect(taskCostUsd({ a: 4 }, 'b')).toBe(0)
  })
})
