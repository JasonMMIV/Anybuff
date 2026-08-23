import { describe, expect, it } from 'bun:test'

import { getProviderOptions } from '../llm'

// AnyBuff local BYOK contract: no hosted codebuff_metadata is ever attached
// to requests. Agent-supplied OpenRouter routing options pass through so
// users routing through openrouter.ai keep provider-order control.
describe('getProviderOptions — local BYOK', () => {
  const baseParams = {
    model: 'openrouter/anthropic/claude-sonnet-4-5',
    runId: 'run-1',
    clientSessionId: 'session-1',
  }

  it('never attaches codebuff_metadata', () => {
    const opts = getProviderOptions(baseParams)
    expect(opts.codebuff).toBeUndefined()
    expect((opts as Record<string, unknown>).codebuff_metadata).toBeUndefined()
    expect(JSON.stringify(opts)).not.toContain('codebuff_metadata')
  })

  it('extraCodebuffMetadata is ignored (no hosted channel)', () => {
    const opts = getProviderOptions({
      ...baseParams,
      extraCodebuffMetadata: { freebuff_instance_id: 'abc-123' },
    })
    expect(JSON.stringify(opts)).not.toContain('freebuff_instance_id')
  })

  it('caller-supplied provider options pass through untouched', () => {
    const opts = getProviderOptions({
      ...baseParams,
      providerOptions: { openaiCompatible: { custom: 'value' } },
    })
    expect(opts.openaiCompatible).toMatchObject({ custom: 'value' })
  })

  it('agent OpenRouter routing options surface under the openrouter namespace', () => {
    const opts = getProviderOptions({
      ...baseParams,
      agentProviderOptions: {
        order: ['Google'],
        allow_fallbacks: false,
      } as any,
    })
    expect(opts.openrouter).toMatchObject({
      order: ['Google'],
      allow_fallbacks: false,
    })
  })

  it('no routing namespace is synthesized without agentProviderOptions', () => {
    const opts = getProviderOptions(baseParams)
    expect(opts.openrouter).toBeUndefined()
  })
})
