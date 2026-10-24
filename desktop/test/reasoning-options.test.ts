import { describe, expect, test } from 'bun:test'

import { getReasoningOptionsForModel, hasKnownLadderForModel } from '../src/renderer/src/utils/reasoning'

/**
 * ADR-27 MC-0.2b: menu literals pass through VERBATIM. `xhigh` and
 * `extra-high` are different wire strings on the same rung — no display
 * layer may rewrite one into the other (§2.1). The previous code normalized
 * `xhigh` → `extra-high`, silently changing what went on the wire.
 */
describe('getReasoningOptionsForModel (MC-0.2b: verbatim literals)', () => {
  test('xhigh stays xhigh — no layer may rewrite it to extra-high', () => {
    const opts = getReasoningOptionsForModel('goat/m', { 'goat/m': ['low', 'xhigh'] })
    expect(opts).toEqual(['default', 'low', 'xhigh'])
  })

  test('unknown vendor rungs pass through for the menu', () => {
    const opts = getReasoningOptionsForModel('goat/m', { 'goat/m': ['low', 'turbo-boost'] })
    expect(opts).toEqual(['default', 'low', 'turbo-boost'])
  })

  test('both spellings coexist as distinct literals (equivalence is display-only)', () => {
    const opts = getReasoningOptionsForModel('goat/m', { 'goat/m': ['xhigh', 'extra-high'] })
    expect(opts).toEqual(['default', 'xhigh', 'extra-high'])
  })

  test('a single declared rung still gets the default sentinel prepended', () => {
    const opts = getReasoningOptionsForModel('goat/m', { 'goat/m': ['xhigh'] })
    expect(opts).toEqual(['default', 'xhigh'])
  })

  test('fallback stays conservative for unknown models', () => {
    expect(getReasoningOptionsForModel('goat/m', {})).toEqual(['default', 'low', 'high'])
  })

  test('hasKnownLadderForModel distinguishes known ladders from fallback (MC-1.6)', () => {
    const ladders = { 'goat/m': ['low', 'xhigh'] }
    expect(hasKnownLadderForModel('goat/m', ladders)).toBe(true)
    expect(hasKnownLadderForModel('goat/m', {})).toBe(false)
    expect(hasKnownLadderForModel(undefined, ladders)).toBe(false)
    // Seed-style bare-id ladders count as known for provider-qualified models
    expect(hasKnownLadderForModel('goat/deepseek-v4-flash', { 'deepseek-v4-flash': ['low', 'high', 'max'] })).toBe(true)
  })
})
