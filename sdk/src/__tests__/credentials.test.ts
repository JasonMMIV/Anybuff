import { describe, expect, test } from 'bun:test'

import {
  getConfigDir,
  getCredentialsPath,
  getUserCredentials,
  userFromJson,
} from '../credentials'

describe('credentials', () => {
  describe('getConfigDir', () => {
    test('ANYBUFF_CONFIG_DIR override wins', () => {
      const dir = getConfigDir({ ANYBUFF_CONFIG_DIR: '/tmp/anybuff-test' } as any)
      expect(dir).toBe('/tmp/anybuff-test')
    })

    test('APPDATA is used on win32', () => {
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { value: 'win32' })
      try {
        const dir = getConfigDir({ APPDATA: 'C:\\Users\\t\\AppData\\Roaming' } as any)
        expect(dir).toContain('anybuff')
        expect(dir).toContain('AppData')
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform })
      }
    })

    test('XDG_CONFIG_HOME is used off Windows', () => {
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { value: 'linux' })
      try {
        const dir = getConfigDir({ XDG_CONFIG_HOME: '/xdg' } as any)
        expect(dir).toContain('anybuff')
        expect(dir).toContain('xdg')
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform })
      }
    })

    test('falls back to ~/.config/anybuff', () => {
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { value: 'linux' })
      try {
        const dir = getConfigDir({} as any)
        expect(dir).toContain('.config')
        expect(dir).toContain('anybuff')
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform })
      }
    })
  })

  describe('getCredentialsPath', () => {
    test('returns path within config directory', () => {
      const credPath = getCredentialsPath({
        ANYBUFF_CONFIG_DIR: '/tmp/anybuff-test',
      } as any)
      expect(credPath).toContain('credentials.json')
      expect(credPath).toContain('anybuff-test')
    })
  })

  describe('userFromJson', () => {
    test('returns null for invalid JSON', () => {
      const user = userFromJson('not valid json')
      expect(user).toBeNull()
    })

    test('returns null for missing default user', () => {
      const json = JSON.stringify({ someOtherKey: { accessToken: 'test' } })
      const user = userFromJson(json)
      expect(user).toBeNull()
    })

    test('returns null for empty object', () => {
      const user = userFromJson('{}')
      expect(user).toBeNull()
    })
  })

  describe('getUserCredentials', () => {
    test('returns null when credentials file does not exist', () => {
      const env = { ANYBUFF_CONFIG_DIR: '/tmp/anybuff-nonexistent-dir' } as any
      const user = getUserCredentials(env)
      expect(user).toBeNull()
    })
  })
})
