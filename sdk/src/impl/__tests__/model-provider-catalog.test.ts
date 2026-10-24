/**
 * ADR-31: catalog-aware capacity resolution in `model-provider.ts`.
 *
 * The precedence here is subtle and load-bearing (plan §5.2/§5.3):
 *   explicit config → A2 learned (real measurement) → catalog → unknown.
 * In particular the catalog must never clamp a learned window DOWN, and
 * `declaredOnly` (used by the overflow-trim decision) must ignore both.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { clearProviderConfigCacheForTest } from '../../provider-config'
import {
  clearModelCatalogCacheForTest,
  setModelCatalogOnline,
} from '../model-catalog-hydration'
import {
  clearLearnedContextWindowsForTest,
  recordLearnedModelContextWindow,
  resolveModelContextOutputTokens,
  resolveModelContextWindow,
} from '../model-provider'
import { catalogContextWindow, catalogOutputTokens } from '../model-catalog'
import { lookupCatalog } from '../model-catalog-hydration'

const MODEL = 'my-deepseek/deepseek-v4-flash'

function config(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    defaultModel: MODEL,
    providers: {
      'my-deepseek': {
        type: 'openai-compatible',
        baseURL: 'https://api.deepseek.com/v1',
        // No apiKeyEnv: resolution is synchronous and must not require an
        // actual key (a missing env var makes resolveConfiguredProviderModel
        // throw, which the capacity walk treats as "unresolvable").
        models: ['deepseek-v4-flash'],
        ...extra,
      },
    },
  }
}

let dataDir: string
let priorConfigEnv: string | undefined

function withConfig(next: Record<string, unknown>): void {
  const configPath = join(dataDir, 'anybuff.json')
  writeFileSync(configPath, JSON.stringify(next))
  process.env.ANYBUFF_PROVIDER_CONFIG = configPath
  clearProviderConfigCacheForTest()
}

beforeEach(() => {
  priorConfigEnv = process.env.ANYBUFF_PROVIDER_CONFIG
  dataDir = mkdtempSync(join(tmpdir(), 'sdk-provider-catalog-'))
  clearProviderConfigCacheForTest()
  clearModelCatalogCacheForTest()
  clearLearnedContextWindowsForTest()
  // Offline: the committed snapshot already knows this model; no test should
  // ever hit models.dev.
  setModelCatalogOnline(false)
  withConfig(config())
})

afterEach(() => {
  clearProviderConfigCacheForTest()
  clearModelCatalogCacheForTest()
  clearLearnedContextWindowsForTest()
  if (priorConfigEnv === undefined) {
    delete process.env.ANYBUFF_PROVIDER_CONFIG
  } else {
    process.env.ANYBUFF_PROVIDER_CONFIG = priorConfigEnv
  }
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    // best-effort
  }
})

describe('catalog fills context windows (plan §5.2)', () => {
  test('windowTokens and outputTokens come from the snapshot', () => {
    const hit = lookupCatalog({
      providerId: 'my-deepseek',
      baseURL: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash',
    })
    expect(hit).toBeTruthy()
    expect(resolveModelContextWindow({ model: MODEL })).toBe(
      catalogContextWindow(hit!.model),
    )
    expect(resolveModelContextOutputTokens({ model: MODEL })).toBe(
      catalogOutputTokens(hit!.model),
    )
  })

  test('declaredOnly ignores the catalog (A2 overflow-trim input)', () => {
    expect(
      resolveModelContextWindow({ model: MODEL, declaredOnly: true }),
    ).toBeUndefined()
  })
})

describe('A2 learned stays above the catalog (plan §5.3)', () => {
  test('a learned window is returned even when the catalog knows a larger one', () => {
    const catalogWindow = resolveModelContextWindow({ model: MODEL })!
    // A gateway that downgrades its window: the real 400 said 600k while the
    // lab-native catalog says ~1M.
    recordLearnedModelContextWindow(MODEL, 600_000)
    expect(resolveModelContextWindow({ model: MODEL })).toBe(600_000)
    expect(600_000).toBeLessThan(catalogWindow)

    // ...and the declared-only view stays empty, so the trim decision keeps
    // trimming to the MEASURED window instead of a catalog value.
    expect(
      resolveModelContextWindow({ model: MODEL, declaredOnly: true }),
    ).toBeUndefined()
  })

  test('an explicit declaration beats both', () => {
    withConfig(
      config({
        modelCapabilities: {
          'deepseek-v4-flash': { context: { windowTokens: 111_111 } },
        },
      }),
    )
    recordLearnedModelContextWindow(MODEL, 600_000)
    expect(resolveModelContextWindow({ model: MODEL })).toBe(111_111)
    expect(resolveModelContextWindow({ model: MODEL, declaredOnly: true })).toBe(
      111_111,
    )
  })
})
