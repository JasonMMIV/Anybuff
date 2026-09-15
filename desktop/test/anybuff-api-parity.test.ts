import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

/**
 * Android WS shim ↔ Electron preload API parity (ADR-21 discipline).
 *
 * `window.AnyBuff` must expose the same method surface over both transports:
 * the Electron preload exposes every business channel via ipcRenderer.invoke,
 * and the Android WebView gets the SAME names through the WS shim in
 * host-ws.ts (createWsAnyBuff). The shim's return value is cast with
 * `as unknown as AnyBuffApi`, so TypeScript CANNOT catch a missing method —
 * the Capabilities tab shipped with the six ADR-27 channels absent from the
 * shim and only failed at runtime on device
 * ("window.AnyBuff.listModelCapabilities is not a function").
 *
 * These tests parse both sources so a channel added to one transport and
 * forgotten in the other fails CI instead of a device test session.
 */

const PRELOAD_PATH = join(import.meta.dir, '../src/preload/index.ts')
const WS_SHIM_PATH = join(import.meta.dir, '../src/renderer/src/host/host-ws.ts')

/** Top-level `name:` keys of the preload `api` literal (2-space indent). */
function extractPreloadMethods(source: string): string[] {
  const keys: string[] = []
  for (const m of source.matchAll(/^ {2}([a-zA-Z0-9_]+):/gm)) {
    // Skip the two type/interface fields that share the 2-space indent
    // inside TodoItem/FileChange — those are not API methods.
    if (!['task', 'completed', 'path', 'action', 'type'].includes(m[1])) {
      keys.push(m[1])
    }
  }
  return [...new Set(keys)]
}

/** `name:` keys of the WS shim's `const api = { … }` literal. */
function extractWsShimMethods(source: string): string[] {
  const start = source.indexOf('const api: Record<string, unknown> = {')
  if (start === -1) return []
  const end = source.indexOf('return api', start)
  const body = end === -1 ? source.slice(start) : source.slice(start, end)
  const keys: string[] = []
  for (const m of body.matchAll(/^ {4}([a-zA-Z0-9_]+):/gm)) keys.push(m[1])
  return [...new Set(keys)]
}

describe('window.AnyBuff surface parity (preload ↔ Android WS shim)', () => {
  const preloadMethods = extractPreloadMethods(readFileSync(PRELOAD_PATH, 'utf8'))
  const wsMethods = extractWsShimMethods(readFileSync(WS_SHIM_PATH, 'utf8'))

  test('both transports expose the same method names', () => {
    const missingInShim = preloadMethods.filter((m) => !wsMethods.includes(m))
    expect(missingInShim).toEqual([])
  })

  test('the shim exposes no methods the preload does not have', () => {
    const extraInShim = wsMethods.filter((m) => !preloadMethods.includes(m))
    expect(extraInShim).toEqual([])
  })

  test('regression: the six ADR-27 capability channels exist in the shim', () => {
    for (const channel of [
      'listModelCapabilities',
      'saveModelCapability',
      'importModelCapabilities',
      'probeReasoningEffort',
      'listProbeSamples',
      'clearProbeSamples',
    ]) {
      expect(wsMethods.includes(channel)).toBe(true)
    }
  })
})
