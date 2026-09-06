import { describe, expect, it } from 'bun:test'

import { classifyFailure } from '../sessions/session-store'
import {
  planOverflowResume,
  resetOverflowResumeCount,
} from '../run/start-run'
import { toCompactionTriggerTokens } from '@codebuff/sdk'

describe('classifyFailure (A4 context-overflow class)', () => {
  it('classifies overflow wording as context-overflow', () => {
    expect(
      classifyFailure("This model's maximum context length is 128000 tokens. However, your messages resulted in 150000 tokens"),
    ).toBe('context-overflow')
    expect(classifyFailure('prompt is too long: 123456 tokens > 100000 maximum')).toBe('context-overflow')
    expect(classifyFailure('context_length_exceeded')).toBe('context-overflow')
  })

  it('keeps existing classes intact', () => {
    expect(classifyFailure('User aborted the run')).toBe('stopped')
    expect(classifyFailure('rate limit exceeded (429)')).toBe('rate-limit')
    expect(classifyFailure('invalid api key (401 unauthorized)')).toBe('auth')
    expect(classifyFailure('request timed out')).toBe('timeout')
    expect(classifyFailure('fetch failed: socket hang up')).toBe('network')
    expect(classifyFailure('something unexpected happened')).toBe('error')
  })
})

describe('planOverflowResume (A4 loop guard)', () => {
  const history = [{ role: 'user', content: 'x' }, { role: 'user', content: 'y' }]
  const W = 200_000
  const trigger = toCompactionTriggerTokens(W)

  it('non-overflow reasons run unchanged', () => {
    expect(
      planOverflowResume({
        resumeReason: 'network',
        previousRunMessageHistory: history,
        effectiveWindowTokens: W,
        previousK: 0,
      }),
    ).toEqual({ action: 'run' })
  })

  it('overflow with no history runs unchanged', () => {
    expect(
      planOverflowResume({
        resumeReason: 'context-overflow',
        previousRunMessageHistory: undefined,
        effectiveWindowTokens: W,
        previousK: 0,
      }),
    ).toEqual({ action: 'run' })
  })

  it('k=1 compacts at the full trigger', () => {
    const plan = planOverflowResume({
      resumeReason: 'context-overflow',
      previousRunMessageHistory: history,
      effectiveWindowTokens: W,
      previousK: 0,
    })
    expect(plan.action).toBe('compact')
    if (plan.action === 'compact') {
      expect(plan.k).toBe(1)
      expect(plan.maxTokens).toBe(trigger)
    }
  })

  it('k=3 compacts at trigger/4', () => {
    const plan = planOverflowResume({
      resumeReason: 'context-overflow',
      previousRunMessageHistory: history,
      effectiveWindowTokens: W,
      previousK: 2,
    })
    expect(plan.action).toBe('compact')
    if (plan.action === 'compact') {
      expect(plan.k).toBe(3)
      expect(plan.maxTokens).toBe(Math.floor(trigger / 4))
    }
  })

  it('k=4 gives up with explicit guidance', () => {
    const plan = planOverflowResume({
      resumeReason: 'context-overflow',
      previousRunMessageHistory: history,
      effectiveWindowTokens: W,
      previousK: 3,
    })
    expect(plan.action).toBe('give-up')
    if (plan.action === 'give-up') {
      expect(plan.message).toContain('Context window')
      expect(plan.message).toContain('windowTokens')
    }
  })

  it('unknown window falls back to 1M (trigger 700k)', () => {
    const plan = planOverflowResume({
      resumeReason: 'context-overflow',
      previousRunMessageHistory: history,
      effectiveWindowTokens: undefined,
      previousK: 0,
    })
    expect(plan.action).toBe('compact')
    if (plan.action === 'compact') {
      expect(plan.maxTokens).toBe(700_000)
    }
  })

  it('resetOverflowResumeCount never throws for unknown tasks', () => {
    // Turn-scoped counter reset (fresh user turn / successful run) — smoke check.
    expect(() => resetOverflowResumeCount('does-not-exist')).not.toThrow()
  })
})
