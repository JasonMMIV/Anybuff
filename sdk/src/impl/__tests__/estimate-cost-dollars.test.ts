/**
 * ADR-31: cost fallback with the catalog's extended pricing slots.
 *
 * The estimator runs only when the endpoint reports no OpenRouter-style cost.
 * Cache reads/writes are a SUBSET of `inputTokens` and reasoning tokens are a
 * subset of `outputTokens`, so the uncached/text remainder must be billed at
 * the plain input/output rates (otherwise the same tokens are charged twice).
 */

import { describe, expect, test } from 'bun:test'

import { estimateCostDollars } from '../llm'

describe('estimateCostDollars', () => {
  test('bills input/output at their per-million rates', () => {
    expect(
      estimateCostDollars(
        { inputTokens: 1_000_000, outputTokens: 500_000 },
        { inputPerMillionTokens: 1, outputPerMillionTokens: 2 },
      ),
    ).toBeCloseTo(2)
  })

  test('returns undefined without usage or rates', () => {
    expect(estimateCostDollars(undefined, { inputPerMillionTokens: 1 })).toBeUndefined()
    expect(estimateCostDollars({ inputTokens: 100 }, undefined)).toBeUndefined()
    expect(estimateCostDollars({ inputTokens: 100 }, { currency: 'USD' })).toBeUndefined()
    expect(estimateCostDollars({ inputTokens: 0, outputTokens: 0 }, { inputPerMillionTokens: 1 })).toBeUndefined()
  })

  test('cache reads/writes use their own rates; the remainder uses input', () => {
    const dollars = estimateCostDollars(
      {
        inputTokens: 1_000_000,
        outputTokens: 0,
        inputTokenDetails: { cacheReadTokens: 600_000, cacheWriteTokens: 100_000 },
      },
      {
        inputPerMillionTokens: 4,
        cachedInputPerMillionTokens: 0.5,
        cacheWritePerMillionTokens: 6,
      },
    )
    // 300k uncached * $4 + 600k cache read * $0.5 + 100k cache write * $6
    expect(dollars).toBeCloseTo(300_000 * 4e-6 + 600_000 * 0.5e-6 + 100_000 * 6e-6)
  })

  test('reasoning tokens use the reasoning rate, the rest the output rate', () => {
    const dollars = estimateCostDollars(
      {
        inputTokens: 0,
        outputTokens: 1_000_000,
        outputTokenDetails: { reasoningTokens: 400_000 },
      },
      {
        outputPerMillionTokens: 10,
        reasoningPerMillionTokens: 20,
      },
    )
    expect(dollars).toBeCloseTo(600_000 * 10e-6 + 400_000 * 20e-6)
  })

  test('the newest reached tier overrides the base rates', () => {
    const pricing = {
      inputPerMillionTokens: 1,
      outputPerMillionTokens: 2,
      tiers: [
        { minContextTokens: 100_000, input: 2, output: 4 },
        { minContextTokens: 200_000, input: 3, output: 6 },
      ],
    }
    expect(
      estimateCostDollars({ inputTokens: 250_000, outputTokens: 0 }, pricing),
    ).toBeCloseTo(250_000 * 3e-6)
    expect(
      estimateCostDollars({ inputTokens: 150_000, outputTokens: 0 }, pricing),
    ).toBeCloseTo(150_000 * 2e-6)
    expect(
      estimateCostDollars({ inputTokens: 50_000, outputTokens: 0 }, pricing),
    ).toBeCloseTo(50_000 * 1e-6)
  })

  test('legacy context_over_200k applies only when no tier matched', () => {
    const pricing = {
      inputPerMillionTokens: 1,
      outputPerMillionTokens: 2,
      contextOver200k: { input: 5, output: 10 },
    }
    expect(
      estimateCostDollars({ inputTokens: 250_000, outputTokens: 0 }, pricing),
    ).toBeCloseTo(250_000 * 5e-6)
    expect(
      estimateCostDollars({ inputTokens: 100_000, outputTokens: 0 }, pricing),
    ).toBeCloseTo(100_000 * 1e-6)
  })

  test('missing cache/reasoning rates fall back to input/output', () => {
    const dollars = estimateCostDollars(
      {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        inputTokenDetails: { cacheReadTokens: 500_000 },
        outputTokenDetails: { reasoningTokens: 500_000 },
      },
      { inputPerMillionTokens: 1, outputPerMillionTokens: 2 },
    )
    // Every token is billed exactly once at the plain rates.
    expect(dollars).toBeCloseTo(3)
  })
})
