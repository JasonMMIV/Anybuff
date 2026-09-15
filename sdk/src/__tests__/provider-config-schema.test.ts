/**
 * Provider schema contract (2026-09-15 protocol-policy revision).
 *
 * The "apiKeyEnv requires https" refine was removed by maintainer decision:
 * it rejected even loopback http, which made one local provider (http
 * baseURL + a prefilled key env) freeze every regeneration of the engine
 * config file. The "http only for local providers" rule stays — remote
 * cleartext is not a supported endpoint shape. These tests pin that split:
 * loopback http works with or without a key env, remote http is rejected,
 * and the structural checks remain in force.
 */

import { describe, expect, test } from 'bun:test'

import { providerConfigFileSchema } from '../provider-config'

function parseProvider(provider: unknown) {
  return providerConfigFileSchema.safeParse({
    defaultModel: 'p/m1',
    providers: { p: provider },
  })
}

describe('provider schema protocol policy (revised 2026-09-15)', () => {
  test('loopback http with apiKeyEnv is accepted (Ollama-style local server)', () => {
    const res = parseProvider({
      type: 'openai-compatible',
      baseURL: 'http://localhost:11434/v1',
      apiKeyEnv: 'OLLAMA_API_KEY',
      models: ['m1'],
    })
    expect(res.success).toBe(true)
  })

  test('loopback http without apiKeyEnv is accepted', () => {
    const res = parseProvider({
      type: 'openai-compatible',
      baseURL: 'http://127.0.0.1:1234/v1',
      models: ['m1'],
    })
    expect(res.success).toBe(true)
  })

  test('IPv6 literal loopback http ([::1]) is accepted as local', () => {
    // URL.hostname keeps the brackets for IPv6 literals ('[::1]'); the
    // local-host check must strip them or this legitimate loopback form is
    // treated as remote cleartext.
    const res = parseProvider({
      type: 'openai-compatible',
      baseURL: 'http://[::1]:11434/v1',
      apiKeyEnv: 'OLLAMA_API_KEY',
      models: ['m1'],
    })
    expect(res.success).toBe(true)
  })

  test('remote http is rejected even without apiKeyEnv', () => {
    const res = parseProvider({
      type: 'openai-compatible',
      baseURL: 'http://gateway.lan:8000/v1',
      models: ['m1'],
    })
    expect(res.success).toBe(false)
    if (!res.success) {
      expect(
        res.error.issues.some((issue) =>
          issue.message.includes('http baseURL is only allowed for local providers'),
        ),
      ).toBe(true)
    }
  })

  test('remote http with apiKeyEnv is rejected', () => {
    const res = parseProvider({
      type: 'openai-compatible',
      baseURL: 'http://gateway.lan:8000/v1',
      apiKeyEnv: 'ANYBUFF_API_KEY',
      models: ['m1'],
    })
    expect(res.success).toBe(false)
  })

  test('anthropic-compatible loopback http with apiKeyEnv is accepted', () => {
    const res = parseProvider({
      type: 'anthropic-compatible',
      baseURL: 'http://localhost:8080',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      models: ['m1'],
    })
    expect(res.success).toBe(true)
  })

  test('a structurally broken baseURL is still rejected', () => {
    const res = parseProvider({
      type: 'openai-compatible',
      baseURL: 'not-a-url',
      apiKeyEnv: 'ANYBUFF_API_KEY',
      models: ['m1'],
    })
    expect(res.success).toBe(false)
  })

  test('an empty defaultModel is rejected (whole-file structural check)', () => {
    const res = providerConfigFileSchema.safeParse({
      defaultModel: '',
      providers: {},
    })
    expect(res.success).toBe(false)
  })
})
