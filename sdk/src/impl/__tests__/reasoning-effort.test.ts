import { describe, expect, test } from 'bun:test'

import {
  VERIFIED_REASONING_EFFORTS,
  clampReasoningEffortToLadder,
  findVerifiedReasoningLadder,
  getVerifiedReasoningLadders,
} from '../reasoning-effort'
import {
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID,
  getFreebuffModelEfforts,
} from '@codebuff/common/constants/freebuff-models'

const DEEPSEEK_LADDER = ['low', 'high', 'max']

describe('VERIFIED_REASONING_EFFORTS (ADR-25 seed table)', () => {
  test('DeepSeek V4 rows stay in lockstep with the upstream catalog', () => {
    // Parity lock (same discipline as context-pruner-parity.test.ts): the
    // seed table must not drift from the vendor-verified upstream rows.
    expect([
      ...VERIFIED_REASONING_EFFORTS['deepseek-v4-flash']!.efforts,
    ]).toEqual([...getFreebuffModelEfforts(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID)!])
    expect([
      ...VERIFIED_REASONING_EFFORTS['deepseek-v4-pro']!.efforts,
    ]).toEqual([...getFreebuffModelEfforts(FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID)!])
    expect(VERIFIED_REASONING_EFFORTS['deepseek-v4-flash']!.verifiedAt).toBe(
      '2026-08-12',
    )
  })

  test('every row carries a verification date and source', () => {
    for (const row of Object.values(VERIFIED_REASONING_EFFORTS)) {
      expect(/^\d{4}-\d{2}-\d{2}$/.test(row.verifiedAt)).toBe(true)
      expect(row.source.length).toBeGreaterThan(0)
      expect(row.efforts.length).toBeGreaterThan(0)
    }
  })

  test('lookup is variant-tolerant: dated/suffixed builds cannot dodge their ladder', () => {
    expect(findVerifiedReasoningLadder('deepseek-v4-flash')?.efforts).toEqual(
      DEEPSEEK_LADDER,
    )
    // Case-insensitive (the legacy menu map shipped capitalized rows).
    expect(findVerifiedReasoningLadder('DeepSeek-V4-Flash')?.efforts).toEqual(
      DEEPSEEK_LADDER,
    )
    // Provider-qualified (BYOK route strings).
    expect(findVerifiedReasoningLadder('goat/deepseek-v4-flash')?.efforts).toEqual(
      DEEPSEEK_LADDER,
    )
    // Variant suffixes: provisioned tiers, gateway tags, dated builds.
    expect(findVerifiedReasoningLadder('deepseek-v4-flash-max')?.efforts).toEqual(
      DEEPSEEK_LADDER,
    )
    expect(findVerifiedReasoningLadder('deepseek-v4-pro:free')?.efforts).toEqual(
      DEEPSEEK_LADDER,
    )
    expect(findVerifiedReasoningLadder('deepseek-v4-pro-0813')?.efforts).toEqual(
      DEEPSEEK_LADDER,
    )
    expect(findVerifiedReasoningLadder(undefined)).toBeUndefined()
    expect(findVerifiedReasoningLadder('gpt-9.9-turbo')).toBeUndefined()
  })

  test('getVerifiedReasoningLadders exposes bare-id keys for host menus', () => {
    expect(getVerifiedReasoningLadders()['deepseek-v4-flash']).toEqual(
      DEEPSEEK_LADDER,
    )
  })
})

describe('clampReasoningEffortToLadder (ADR-25 request-time clamp)', () => {
  const deepseek = VERIFIED_REASONING_EFFORTS['deepseek-v4-flash']!

  test('the vendor requestMap wins over generic clamp-down', () => {
    // DeepSeek's documented table maps medium→high; a naive clamp-down would
    // send `low` — the opposite end of the ladder.
    expect(
      clampReasoningEffortToLadder('medium', deepseek.efforts, deepseek.requestMap),
    ).toBe('high')
  })

  test('alias and above-ceiling requests clamp to the nearest rung', () => {
    expect(
      clampReasoningEffortToLadder('xhigh', deepseek.efforts, deepseek.requestMap),
    ).toBe('high')
    expect(
      clampReasoningEffortToLadder(
        'extra-high',
        deepseek.efforts,
        deepseek.requestMap,
      ),
    ).toBe('high')
    expect(
      clampReasoningEffortToLadder(
        'minimal',
        deepseek.efforts,
        deepseek.requestMap,
      ),
    ).toBe('low')
    expect(
      clampReasoningEffortToLadder('none', deepseek.efforts, deepseek.requestMap),
    ).toBe('low')
    expect(
      clampReasoningEffortToLadder('ultra', deepseek.efforts, deepseek.requestMap),
    ).toBe('max')
  })

  test('native rungs pass through untouched', () => {
    for (const rung of DEEPSEEK_LADDER) {
      expect(
        clampReasoningEffortToLadder(rung, deepseek.efforts, deepseek.requestMap),
      ).toBe(rung)
    }
  })

  test('unknown vocabulary passes through verbatim — never silently rewritten', () => {
    // DeepSeek accepts any string (a 200 proves nothing); other providers
    // reject loudly. Either way, guessing would be suppression's cousin.
    expect(
      clampReasoningEffortToLadder(
        'gigantic',
        deepseek.efforts,
        deepseek.requestMap,
      ),
    ).toBe('gigantic')
  })

  test('ladders without a requestMap use generic clamp-down', () => {
    expect(clampReasoningEffortToLadder('max', ['low', 'high'])).toBe('high')
    expect(clampReasoningEffortToLadder('medium', ['low', 'high'])).toBe('low')
    expect(clampReasoningEffortToLadder('low', ['medium', 'high'])).toBe('medium')
    expect(clampReasoningEffortToLadder('high', ['low', 'high'])).toBe('high')
  })

  test('an empty ladder is a passthrough (callers decide)', () => {
    expect(clampReasoningEffortToLadder('medium', [])).toBe('medium')
  })
})
