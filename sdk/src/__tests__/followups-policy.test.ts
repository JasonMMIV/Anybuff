import { describe, expect, test } from 'bun:test'

import { applyFollowupsPolicy } from '../impl/followups-policy'

type Def = {
  id: string
  toolNames?: string[]
  systemPrompt?: string
  instructionsPrompt?: string
}

const sampleDef: Def = {
  id: 'base2',
  toolNames: ['read_files', 'suggest_followups', 'write_file'],
  systemPrompt: 'You are Buffy.\n\n- At the end of your turn, use the suggest_followups tool to suggest next steps.\n\n# Rules',
  instructionsPrompt:
    'Instructions:\n- gather context\n- At the end of your turn, use the suggest_followups tool to suggest ~3 next steps the user might want to take.',
}

describe('applyFollowupsPolicy (default: disabled)', () => {
  test('strips suggest_followups from toolNames', () => {
    const [out] = applyFollowupsPolicy([sampleDef])
    expect(out.toolNames).toEqual(['read_files', 'write_file'])
  })

  test('removes prompt guidance lines mentioning suggest_followups', () => {
    const [out] = applyFollowupsPolicy([sampleDef])
    expect(out.systemPrompt).not.toContain('suggest_followups')
    expect(out.instructionsPrompt).not.toContain('suggest_followups')
    // Neighboring lines survive
    expect(out.systemPrompt).toContain('# Rules')
    expect(out.systemPrompt).toContain('You are Buffy.')
    expect(out.instructionsPrompt).toContain('- gather context')
  })

  test('does not mutate caller-owned definitions', () => {
    const original = { ...sampleDef }
    applyFollowupsPolicy([sampleDef])
    expect(sampleDef).toEqual(original)
    expect(sampleDef.toolNames).toContain('suggest_followups')
  })

  test('returns a new array instance even when enabled passthrough', () => {
    // Note: default env has followups disabled; simulate enabled via a fresh
    // module evaluation is overkill — instead assert identity semantics only
    // when the flag happens to be on in the test environment.
    if (process.env.ANYBUFF_FOLLOWUPS === '1') {
      const out = applyFollowupsPolicy([sampleDef])
      expect(out[0]).toBe(sampleDef)
    } else {
      const out = applyFollowupsPolicy([sampleDef])
      expect(out[0]).not.toBe(sampleDef)
    }
  })
})

describe('applyFollowupsPolicy (ANYBUFF_FOLLOWUPS=1)', () => {
  test('passes definitions through untouched', async () => {
    // Re-evaluate module with flag set via Bun's import cache reset.
    process.env.ANYBUFF_FOLLOWUPS = '1'
    const mod = await import('../impl/followups-policy')
    const [out] = mod.applyFollowupsPolicy([sampleDef])
    expect(out).toBe(sampleDef)
    expect((out as Def).toolNames).toContain('suggest_followups')
    delete process.env.ANYBUFF_FOLLOWUPS
  })
})
