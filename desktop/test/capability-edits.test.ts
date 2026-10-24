import { describe, expect, test } from 'bun:test'
import { diffCapabilityEdits, type CapabilityEditValues } from '../src/renderer/src/utils/capability-edits'

const baseline: CapabilityEditValues = {
  efforts: 'low, high, max',
  defaultEffort: 'high',
  wire: 'auto',
  budgetTokens: '',
  windowTokens: '128000',
  outputTokens: '8192',
  paramsText: '',
}

describe('diffCapabilityEdits', () => {
  test('an untouched row has no changes', () => {
    const diff = diffCapabilityEdits(baseline, { ...baseline })
    expect(diff.changed).toBe(false)
    expect(diff.efforts).toEqual(['low', 'high', 'max'])
  })

  test('rung whitespace/order normalisation still counts as a change', () => {
    const diff = diffCapabilityEdits(baseline, { ...baseline, efforts: ' low , high,max ' })
    expect(diff.changed).toBe(false)
    const reordered = diffCapabilityEdits(baseline, { ...baseline, efforts: 'high, low, max' })
    expect(reordered.effortsChanged).toBe(true)
  })

  test('only the context field the user changed is flagged', () => {
    const diff = diffCapabilityEdits(baseline, { ...baseline, windowTokens: '64000' })
    expect(diff.changed).toBe(true)
    expect(diff.windowChanged).toBe(true)
    expect(diff.outputChanged).toBe(false)
    expect(diff.effortsChanged).toBe(false)
    expect(diff.defaultEffortChanged).toBe(false)
    expect(diff.wireChanged).toBe(false)
    expect(diff.budgetChanged).toBe(false)
    expect(diff.paramsChanged).toBe(false)
  })

  test('params text is compared semantically enough for the editor (trim only)', () => {
    const diff = diffCapabilityEdits(
      { ...baseline, paramsText: '{\n  "thinking_budget": 32000\n}' },
      { ...baseline, paramsText: '  {\n  "thinking_budget": 32000\n}  ' }
    )
    expect(diff.paramsChanged).toBe(false)
  })
})
