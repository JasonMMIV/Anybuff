/**
 * ADR-32 (batch 2): named reasoning wire dialects.
 *
 * Three invariants are load-bearing:
 *   1. `auto` is BYTE-IDENTICAL to the historical write (the function returns
 *      the same object, so no key can drift);
 *   2. a named dialect is the SINGLE reasoning writer — other dialects' keys
 *      are removed (a budget-only endpoint must not receive reasoning_effort);
 *   3. no dialect ever writes a "reasoning off" value (ADR-10). `*.none`
 *      removes keys, it never sends `thinking:{type:'disabled'}` or
 *      `enable_thinking:false`.
 */

import { describe, expect, test } from 'bun:test'

import {
  anthropicReasoningProviderOptions,
  applyOpenAIReasoningWire,
  resolveReasoningWire,
} from '../reasoning-wire'
import { buildConfiguredProviderRequestBody } from '../model-provider'

describe('resolveReasoningWire', () => {
  test('defaults to auto', () => {
    expect(resolveReasoningWire({ protocol: 'openai' })).toEqual({
      protocol: 'openai',
      dialect: 'auto',
    })
  })

  test('accepts a dialect that belongs to the protocol', () => {
    expect(
      resolveReasoningWire({ protocol: 'openai', wire: 'chat.thinking_budget', budgetTokens: 32000 }),
    ).toEqual({
      protocol: 'openai',
      dialect: 'chat.thinking_budget',
      budgetTokens: 32000,
    })
    expect(
      resolveReasoningWire({ protocol: 'anthropic', wire: 'claude.budget', budgetTokens: 1024 }),
    ).toEqual({
      protocol: 'anthropic',
      dialect: 'claude.budget',
      budgetTokens: 1024,
    })
  })

  test('a cross-protocol dialect falls back to auto (never silently applies)', () => {
    expect(
      resolveReasoningWire({ protocol: 'openai', wire: 'claude.budget' }).dialect,
    ).toBe('auto')
    expect(
      resolveReasoningWire({ protocol: 'anthropic', wire: 'chat.effort' }).dialect,
    ).toBe('auto')
  })

  test('budgetTokens must be a positive integer', () => {
    expect(
      resolveReasoningWire({ protocol: 'openai', wire: 'chat.thinking_budget', budgetTokens: 0 })
        .budgetTokens,
    ).toBeUndefined()
    expect(
      resolveReasoningWire({ protocol: 'openai', wire: 'chat.thinking_budget', budgetTokens: 10.9 })
        .budgetTokens,
    ).toBe(10)
  })

  test('a named dialect is flagged by its dialect id, auto is not', () => {
    expect(resolveReasoningWire({ protocol: 'openai' }).dialect).toBe('auto')
    expect(
      resolveReasoningWire({ protocol: 'openai', wire: 'chat.none' }).dialect,
    ).toBe('chat.none')
  })
})

describe('applyOpenAIReasoningWire', () => {
  const baseBody = () => ({
    model: 'm',
    reasoning_effort: 'high',
    thinking_budget: 1234,
    enable_thinking: true,
    reasoning: { effort: 'high' },
    chat_template_args: { keep: 'me' },
    temperature: 0.2,
  })

  test('auto returns the SAME object (byte-identical invariant)', () => {
    const body = baseBody()
    expect(applyOpenAIReasoningWire(body, { protocol: 'openai', dialect: 'auto' })).toBe(body)
    expect(applyOpenAIReasoningWire(body, undefined)).toBe(body)
  })

  test('chat.effort keeps reasoning_effort (and provider-level enable_thinking)', () => {
    const next = applyOpenAIReasoningWire(baseBody(), {
      protocol: 'openai',
      dialect: 'chat.effort',
    })
    expect(next.reasoning_effort).toBe('high')
    expect(next.enable_thinking).toBe(true)
    expect('thinking_budget' in next).toBe(false)
    expect('reasoning' in next).toBe(false)
    // unrelated keys survive untouched
    expect(next.chat_template_args).toEqual({ keep: 'me' })
    expect(next.temperature).toBe(0.2)
  })

  test('chat.thinking_budget writes the budget and drops reasoning_effort', () => {
    const next = applyOpenAIReasoningWire(baseBody(), {
      protocol: 'openai',
      dialect: 'chat.thinking_budget',
      budgetTokens: 32000,
    })
    expect(next.thinking_budget).toBe(32000)
    expect('reasoning_effort' in next).toBe(false)
    expect('reasoning' in next).toBe(false)
    expect(next.enable_thinking).toBe(true)
  })

  test('chat.thinking_budget without a budget writes no reasoning key', () => {
    const next = applyOpenAIReasoningWire(baseBody(), {
      protocol: 'openai',
      dialect: 'chat.thinking_budget',
    })
    expect('thinking_budget' in next).toBe(false)
    expect('reasoning_effort' in next).toBe(false)
  })

  test('chat.enable_thinking writes true + budget — never false', () => {
    const body = baseBody()
    body.enable_thinking = false
    const next = applyOpenAIReasoningWire(body, {
      protocol: 'openai',
      dialect: 'chat.enable_thinking',
      budgetTokens: 2048,
    })
    expect(next.enable_thinking).toBe(true)
    expect(next.thinking_budget).toBe(2048)
    expect('reasoning_effort' in next).toBe(false)
  })

  test('chat.reasoning_obj converts the effort into a nested object', () => {
    const next = applyOpenAIReasoningWire(baseBody(), {
      protocol: 'openai',
      dialect: 'chat.reasoning_obj',
    })
    expect(next.reasoning).toEqual({ effort: 'high' })
    expect('reasoning_effort' in next).toBe(false)
    expect('thinking_budget' in next).toBe(false)
  })

  test('chat.none removes every managed reasoning key and writes nothing', () => {
    const next = applyOpenAIReasoningWire(baseBody(), {
      protocol: 'openai',
      dialect: 'chat.none',
    })
    for (const key of ['reasoning_effort', 'thinking_budget', 'enable_thinking', 'reasoning']) {
      expect(key in next).toBe(false)
    }
    // ADR-10: absence, never an explicit "off".
    expect(JSON.stringify(next)).not.toContain('disabled')
    expect(JSON.stringify(next)).not.toContain('"enable_thinking":false')
  })

  test('a stale default sentinel is never written', () => {
    const next = applyOpenAIReasoningWire(
      { reasoning_effort: 'default' },
      { protocol: 'openai', dialect: 'chat.effort' },
    )
    expect('reasoning_effort' in next).toBe(false)
  })
})

describe('anthropicReasoningProviderOptions', () => {
  test('auto sends effort only for the three documented rungs', () => {
    expect(
      anthropicReasoningProviderOptions({ protocol: 'anthropic', dialect: 'auto' }, 'medium'),
    ).toEqual({ effort: 'medium' })
    expect(
      anthropicReasoningProviderOptions({ protocol: 'anthropic', dialect: 'auto' }, 'extra-high'),
    ).toBeUndefined()
    expect(
      anthropicReasoningProviderOptions({ protocol: 'anthropic', dialect: 'auto' }, 'max'),
    ).toBeUndefined()
    expect(
      anthropicReasoningProviderOptions({ protocol: 'anthropic', dialect: 'auto' }, 'default'),
    ).toBeUndefined()
  })

  test('claude.effort maps low/medium/high', () => {
    for (const effort of ['low', 'medium', 'high']) {
      expect(
        anthropicReasoningProviderOptions(
          { protocol: 'anthropic', dialect: 'claude.effort' },
          effort,
        ),
      ).toEqual({ effort })
    }
    expect(
      anthropicReasoningProviderOptions(
        { protocol: 'anthropic', dialect: 'claude.effort' },
        'ultra',
      ),
    ).toBeUndefined()
  })

  test('claude.budget writes thinking.enabled + budgetTokens (no effort needed)', () => {
    expect(
      anthropicReasoningProviderOptions(
        { protocol: 'anthropic', dialect: 'claude.budget', budgetTokens: 32000 },
        undefined,
      ),
    ).toEqual({ thinking: { type: 'enabled', budgetTokens: 32000 } })
    expect(
      anthropicReasoningProviderOptions(
        { protocol: 'anthropic', dialect: 'claude.budget' },
        'high',
      ),
    ).toBeUndefined()
  })

  test('claude.none writes nothing even when an effort is picked', () => {
    expect(
      anthropicReasoningProviderOptions(
        { protocol: 'anthropic', dialect: 'claude.none' },
        'high',
      ),
    ).toBeUndefined()
  })

  test('no dialect can produce a disabled thinking block', () => {
    const dials = ['auto', 'claude.effort', 'claude.budget', 'claude.none'] as const
    for (const dialect of dials) {
      const options = anthropicReasoningProviderOptions(
        { protocol: 'anthropic', dialect, budgetTokens: 1024 },
        'high',
      )
      expect(JSON.stringify(options ?? {})).not.toContain('disabled')
    }
  })
})

describe('request-body composition (plan §16.3 ordering)', () => {
  const resolved = {
    providerId: 'gateway',
    providerModel: 'some-model',
    compatibility: { supportsRequiredToolChoice: true },
  }

  test('auto keeps the historical order: the body wins over customBody', () => {
    const body = buildConfiguredProviderRequestBody({
      body: { reasoning_effort: 'high', temperature: 0.1 },
      customBody: { reasoning_effort: 'low', top_k: 5 },
      providerType: 'openai-compatible',
      resolved,
    })
    expect(body.reasoning_effort).toBe('high')
    expect(body.top_k).toBe(5)
  })

  test('a named dialect lets customBody override the dialect keys', () => {
    const body = buildConfiguredProviderRequestBody({
      body: { reasoning_effort: 'high' },
      customBody: { reasoning_effort: 'low' },
      providerType: 'openai-compatible',
      reasoningWire: {
        protocol: 'openai',
        dialect: 'chat.thinking_budget',
        budgetTokens: 32000,
      },
      resolved,
    })
    expect(body.thinking_budget).toBe(32000)
    // customBody is the escape hatch: it wins over the dialect write.
    expect(body.reasoning_effort).toBe('low')
  })

  test('compatibility strip runs AFTER customBody (never re-introduces a 400)', () => {
    const body = buildConfiguredProviderRequestBody({
      body: { tool_choice: 'auto', stop: ['x'] },
      customBody: { tool_choice: 'required' },
      providerType: 'openai-compatible',
      reasoningWire: { protocol: 'openai', dialect: 'chat.none' },
      resolved: {
        providerId: 'gateway',
        providerModel: 'some-model',
        compatibility: {
          supportsRequiredToolChoice: false,
          supportsStopSequences: false,
        },
      },
    })
    // The compat layer writes the key as `undefined`; JSON.stringify drops it
    // on the wire (the pre-existing shape is preserved).
    expect(body.tool_choice).toBeUndefined()
    expect(body.stop).toBeUndefined()
  })

  test('anthropic customBody is merged last and still compat-stripped', () => {
    const body = buildConfiguredProviderRequestBody({
      body: { thinking: { type: 'enabled', budget_tokens: 1024 }, stop_sequences: ['x'] },
      customBody: {
        thinking: { type: 'enabled', budget_tokens: 4096 },
        stop_sequences: ['y'],
        metadata: { user_id: 'u1' },
      },
      providerType: 'anthropic-compatible',
      resolved: {
        providerId: 'gateway',
        providerModel: 'some-model',
        compatibility: { supportsStopSequences: false },
      },
    })
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 })
    expect(body.metadata).toEqual({ user_id: 'u1' })
    expect('stop_sequences' in body).toBe(false)
  })
})
