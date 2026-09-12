import { describe, expect, test } from 'bun:test'

import { getReasoningOptionsForModel, hasKnownLadderForModel } from '../src/renderer/src/utils/reasoning'
import { buildMaintenancePrompt } from '../src/renderer/src/components/ModelCapabilitiesPanel'

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

/**
 * MC-1.4: the Import card's copyable maintenance prompt — the §6 template
 * now lives IN the UI (the docs reference was dangling). Lock its shape:
 * wire-literal rungs (no alias rewrites), unverified-over-guessing, the
 * JSON block template the importer parses, and the configured providers.
 */
describe('buildMaintenancePrompt (MC-1.4: prompt embedded in UI)', () => {
  test('carries the §6 essentials: no-guessing, verbatim rungs, JSON shape, source URL', () => {
    const prompt = buildMaintenancePrompt([{ id: 'goat', label: 'Goat' }])
    expect(prompt).toContain('official documentation')
    expect(prompt).toContain('unverified')
    // §2.1: the prompt must instruct verbatim wire values, never alias rewrites.
    expect(prompt).toContain('never rewrite it to "extra-high"')
    expect(prompt).toContain('"providerId"')
    expect(prompt).toContain('"windowTokens"')
    expect(prompt).toContain('source URL')
  })

  test('lists the configured providers so the LLM can pick the right id', () => {
    const prompt = buildMaintenancePrompt([
      { id: 'goat', label: 'Goat' },
      { id: 'ollama', label: 'Local' },
    ])
    expect(prompt).toContain('goat (Goat)')
    expect(prompt).toContain('ollama (Local)')
  })

  test('survives an empty provider list', () => {
    const prompt = buildMaintenancePrompt([])
    expect(prompt).toContain('<none configured>')
  })
})
