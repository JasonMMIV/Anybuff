import { describe, expect, test } from 'bun:test'

import { CodebuffClient } from '../client'

// AnyBuff local BYOK contract: checkConnection has no backend to probe and
// always reports healthy; the hosted API key is optional.
describe('CodebuffClient', () => {
  describe('constructor (local BYOK)', () => {
    test('accepts a missing apiKey for keyless local providers', () => {
      const client = new CodebuffClient({})
      expect(client.options.apiKey).toBe('')
    })

    test('keeps an explicitly provided apiKey', () => {
      const client = new CodebuffClient({ apiKey: 'hosted-or-proxy-key' })
      expect(client.options.apiKey).toBe('hosted-or-proxy-key')
    })

    test('generates a random fingerprintId', () => {
      const client = new CodebuffClient({})
      expect(client.options.fingerprintId).toMatch(/^codebuff-sdk-/)
    })
  })

  describe('checkConnection (local no-op)', () => {
    test('always reports healthy without any network access', async () => {
      const client = new CodebuffClient({})
      expect(await client.checkConnection()).toBe(true)
    })
  })
})
