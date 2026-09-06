import { describe, expect, it } from 'bun:test'

import {
  CONTEXT_RESERVE_MIN_TOKENS,
  UNKNOWN_MODEL_CONTEXT_FALLBACK,
  reserveTokens,
  toCompactionTriggerTokens,
} from '../util/context-trim'

/**
 * Worked examples from the plan §3.3 v2 table (AnyBuff context-management
 * improvement plan). Every value is an exact integer assertion — the formula
 * is frozen; drift here means a regression in the compaction budget.
 */
describe('reserveTokens', () => {
  it('claude-sonnet-4-5: W=200k, out=64k → reserve=64k', () => {
    expect(reserveTokens(200_000, 64_000)).toBe(64_000)
  })

  it('gpt-5.2: W=272k, out=128k → reserve capped at 64k', () => {
    expect(reserveTokens(272_000, 128_000)).toBe(64_000)
  })

  it('kimi-k2.6: W=262_144, out=262_144 → reserve=64k (output cap)', () => {
    expect(reserveTokens(262_144, 262_144)).toBe(64_000)
  })

  it('qwen2.5-coder:32b: W=32_768, out=32_768 → 0.5W guard wins', () => {
    // max(0.12W, min(out, 64k)) = 32_768, clamped to [8k, 16_384] → 16_384
    expect(reserveTokens(32_768, 32_768)).toBe(16_384)
  })

  it('W=1M, out unknown → flat 12% = 120k', () => {
    expect(reserveTokens(1_000_000)).toBe(120_000)
  })

  it('W=32_768, out unknown → min clamp 8k', () => {
    expect(reserveTokens(32_768)).toBe(8_000)
  })

  it('reserve never exceeds 0.5W', () => {
    for (const w of [4_000, 16_384, 65_536, 200_000, 1_000_000]) {
      expect(reserveTokens(w, 1_000_000)).toBeLessThanOrEqual(Math.floor(0.5 * w))
    }
  })

  it('degenerate window clamps to a 1-token window (reserve 0)', () => {
    expect(reserveTokens(0, 0)).toBe(0)
    expect(reserveTokens(-5)).toBe(0)
  })
})

describe('toCompactionTriggerTokens', () => {
  it('claude-sonnet-4-5: W=200k, out=64k → trigger=136_000', () => {
    expect(toCompactionTriggerTokens(200_000, 64_000)).toBe(136_000)
  })

  it('gpt-5.2: W=272k, out=128k → trigger=min(190_400, 208_000)=190_400', () => {
    expect(toCompactionTriggerTokens(272_000, 128_000)).toBe(190_400)
  })

  it('kimi-k2.6: W=262_144, out=262_144 → trigger=183_500', () => {
    expect(toCompactionTriggerTokens(262_144, 262_144)).toBe(183_500)
  })

  it('qwen2.5-coder:32b: W=32_768, out=32_768 → trigger=16_384', () => {
    expect(toCompactionTriggerTokens(32_768, 32_768)).toBe(16_384)
  })

  it('W=1M, out unknown → trigger=700_000', () => {
    expect(toCompactionTriggerTokens(1_000_000)).toBe(700_000)
  })

  it('W=32_768, out unknown → trigger=floor(22_937.6)=22_937', () => {
    expect(toCompactionTriggerTokens(32_768)).toBe(22_937)
  })

  it('trigger is always ≥1 and ≤ W (strictly < W for real windows)', () => {
    for (const w of [1, 100, 8_000, 32_768, 200_000, 1_000_000]) {
      const trigger = toCompactionTriggerTokens(w)
      expect(trigger).toBeGreaterThanOrEqual(1)
      expect(trigger).toBeLessThanOrEqual(w)
      // A real window (≥2 tokens) always leaves headroom for the reserve.
      if (w >= 2) expect(trigger).toBeLessThan(w)
    }
  })

  it('unknown-window fallback is 1M (v3 decision)', () => {
    expect(UNKNOWN_MODEL_CONTEXT_FALLBACK).toBe(1_000_000)
    expect(CONTEXT_RESERVE_MIN_TOKENS).toBe(8_000)
  })
})
