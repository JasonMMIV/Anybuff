import { describe, expect, test } from 'bun:test'

import {
  FREEBUFF_FABLE_5_MODEL_ID,
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID,
  FREEBUFF_MINIMAX_M3_MODEL_ID,
  FREEBUFF_MIMO_V25_MODEL_ID,
} from '@codebuff/common/constants/freebuff-models'

import { createBase2 } from '../base2/base2'
import { createBaseDeep } from '../base2/base-deep'
import codeReviewerLite from '../reviewer/code-reviewer-lite'

const FREEBUFF_KIMI_MODEL_ID = 'moonshotai/kimi-k2.7-code'
// Removed from Freebuff 2026-08-04, so it is now just an unmapped model here.
const FREEBUFF_MIMO_V25_PRO_MODEL_ID = 'mimo/mimo-v2.5-pro'

describe('base2 reviewer selection', () => {
  // NOTE (AnyBuff, ADR-15 follow-up): per-model reviewers/thinkers were
  // removed. createBase2 now resolves every lean mode to the generic
  // code-reviewer (lite keeps code-reviewer-lite), regardless of model.
  test('Codebuff lite uses GPT-5.6 Luna and the lite reviewer', () => {
    const base2 = createBase2('lite')

    expect(base2.model).toBe('openai/gpt-5.6-luna')
    expect(base2.spawnableAgents).toContain('code-reviewer-lite')
    expect(base2.instructionsPrompt).toContain('Spawn a code-reviewer-lite')
  })

  test('free mode uses the generic reviewer, not a per-model one', () => {
    const base2 = createBase2('free')

    expect(base2.model).toBe(FREEBUFF_MINIMAX_M3_MODEL_ID)
    expect(base2.spawnableAgents).toContain('code-reviewer')
    expect(base2.spawnableAgents).not.toContain('code-reviewer-minimax-m3')
    expect(base2.instructionsPrompt).toContain('Spawn a code-reviewer')
  })

  test('the lite reviewer runs the same model as lite mode', () => {
    expect(codeReviewerLite.model).toBe('openai/gpt-5.6-luna')
  })

  test('any free model resolves to the generic reviewer, never lite\u2019s', () => {
    // Never code-reviewer-lite: that one runs Codebuff's paid lite model now,
    // which free mode is not allowed to spend on.
    const base2 = createBase2('free', { model: 'some/unmapped-free-model' })

    expect(base2.spawnableAgents).toContain('code-reviewer')
    expect(base2.spawnableAgents).not.toContain('code-reviewer-lite')
    expect(base2.instructionsPrompt).toContain('Spawn a code-reviewer')
  })

  test('free mode cannot reach the paid reviewer even on lite’s own model', () => {
    // Per-model reviewers are gone; free mode on any model resolves to the
    // generic code-reviewer, never lite's.
    const base2 = createBase2('free', { model: 'openai/gpt-5.6-luna' })

    expect(base2.spawnableAgents).not.toContain('code-reviewer-lite')
    expect(base2.spawnableAgents).toContain('code-reviewer')
    expect(base2.systemPrompt).not.toContain('code-reviewer-lite')
    expect(base2.instructionsPrompt).not.toContain('code-reviewer-lite')
  })

  test.each([
    FREEBUFF_MINIMAX_M3_MODEL_ID,
    FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID,
    FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
    FREEBUFF_MIMO_V25_MODEL_ID,
  ])('every free model resolves to the generic reviewer (%p)', (model) => {
    const base2 = createBase2('free', { model })

    expect(base2.spawnableAgents).toContain('code-reviewer')
    expect(base2.instructionsPrompt).toContain('Spawn a code-reviewer')
  })

  test('lite keeps its own reviewer regardless of model override', () => {
    // AnyBuff: per-model reviewers are gone, so lite always gets
    // code-reviewer-lite (same model as the orchestrator).
    const base2 = createBase2('lite', { model: FREEBUFF_MIMO_V25_MODEL_ID })

    expect(base2.spawnableAgents).toContain('code-reviewer-lite')
    expect(base2.spawnableAgents).not.toContain('code-reviewer-mimo')
  })

  test('an unmapped model still resolves to a valid reviewer', () => {
    // Kimi was removed from Freebuff on 2026-07-31 along with its reviewer,
    // and MiMo 2.5 Pro on 2026-08-04, so both are now just unmapped models.
    // AnyBuff: per-model reviewers are gone, so every lean mode resolves to
    // the generic code-reviewer (lite keeps its own).
    for (const mode of ['free', 'lite'] as const) {
      const base2 = createBase2(mode, { model: FREEBUFF_KIMI_MODEL_ID })
      expect(base2.spawnableAgents).not.toContain('code-reviewer-kimi')
      const mimoPro = createBase2(mode, {
        model: FREEBUFF_MIMO_V25_PRO_MODEL_ID,
      })
      expect(mimoPro.spawnableAgents).not.toContain('code-reviewer-mimo-pro')
      const expected = mode === 'lite' ? 'code-reviewer-lite' : 'code-reviewer'
      expect(base2.spawnableAgents).toContain(expected)
    }
  })
})

describe('base2 lean thinker escalation', () => {
  // AnyBuff: per-model gemini thinkers (thinker-gemini, thinker-with-files-
  // gemini) were removed (ADR-15 follow-up). Lean modes escalate to the shared
  // 'thinker', whose model anybuff.json can override.

  test('lite gets the shared thinker escalation', () => {
    const lite = createBase2('lite')

    expect(lite.spawnableAgents).toContain('thinker')
    expect(lite.systemPrompt).toContain('Spawn the thinker agent')
    expect(lite.instructionsPrompt).toContain('spawn the thinker agent')
  })

  test('lite keeps it regardless of model; free mode does not', () => {
    // lite is billed, so its escalation path survives any model override.
    // free mode resolves the generic reviewer but does not get the extra
    // thinker escalation (its root already carries direct reasoning guidance).
    expect(
      createBase2('lite', { model: FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID })
        .spawnableAgents,
    ).toContain('thinker')
    expect(
      createBase2('free', { model: FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID })
        .spawnableAgents,
    ).not.toContain('thinker')
    expect(createBase2('free').spawnableAgents).not.toContain('thinker')
  })

  test.each(['default', 'max'] as const)(
    '%s mode does not get the lean escalation',
    (mode) => {
      // default/max carry the thinker too, but not the lean escalation
      // language that lite gets (escalation path / more expensive model).
      const systemPrompt = createBase2(mode).systemPrompt!
      expect(systemPrompt).not.toContain('escalation path')
      expect(systemPrompt).not.toContain(
        'more expensive model than lite itself',
      )
    },
  )
})

describe('production agent step prompts', () => {
  test('base2 and base-deep rely on their non-repeating prompts', () => {
    const agents = [
      ...(['default', 'free', 'lite', 'max', 'fast'] as const).map((mode) =>
        createBase2(mode),
      ),
      createBase2('default', { planOnly: true }),
      createBaseDeep(),
    ]

    for (const agent of agents) {
      expect('stepPrompt' in agent).toBe(false)
    }
  })

  test('plan-only keeps its no-edit constraint in the instructions', () => {
    const agent = createBase2('default', { planOnly: true })

    expect(agent.instructionsPrompt).toContain('Do not make file changes')
  })
})

describe('base2 escalation guidance', () => {
  test('lite names one escalation path and prices it honestly', () => {
    // lite's only escalation is the shared thinker, which runs a more
    // expensive model. The prompt must be honest about the cost delta.
    const systemPrompt = createBase2('lite').systemPrompt!

    expect(systemPrompt).toContain(
      "thinker agent is lite mode's escalation path",
    )
    expect(systemPrompt).toContain(
      'more expensive model than lite itself',
    )
    expect(systemPrompt).not.toContain('thinker-gpt')
    expect(systemPrompt).toContain('DEFAULT or MAX mode')
    // The rationale must be Codebuff's cost story, not Freebuff's.
    expect(systemPrompt).not.toContain('ChatGPT subscription')
  })

  test('lite never argues against its own escalation path', () => {
    const systemPrompt = createBase2('lite').systemPrompt!

    expect(systemPrompt).toContain('Spawn the thinker agent')
    expect(systemPrompt).not.toMatch(/Do not spawn[^.]*thinker/)
  })

  test('the shared thinker stays spawnable so an explicit request works', () => {
    const lite = createBase2('lite')

    expect(lite.spawnableAgents).toContain('thinker')
    expect(lite.spawnableAgents).not.toContain('thinker-gpt')
    expect(lite.spawnableAgents).not.toContain('thinker-with-files-gemini')
  })

  test.each([
    ['default free root', undefined],
    ['Fable', FREEBUFF_FABLE_5_MODEL_ID],
    ['DeepSeek Flash', FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID],
  ] as const)('%s has no per-model thinker to restrict', (_label, model) => {
    // AnyBuff: per-model thinkers were removed entirely, so no mode names
    // them — which would just invite a spawn that cannot succeed.
    const free = createBase2('free', model ? { model } : undefined)
    const prompts = [
      free.systemPrompt,
      free.instructionsPrompt,
      free.stepPrompt,
    ].join('\n')

    expect(free.spawnableAgents).not.toContain('thinker-gpt')
    expect(prompts).not.toContain('thinker-gpt')
    expect(prompts).not.toContain('ChatGPT')
  })

  test.each(['default', 'max'] as const)(
    '%s mode is left unrestricted',
    (mode) => {
      // The full-price modes are meant to reach for deeper reasoning.
      const systemPrompt = createBase2(mode).systemPrompt!

      expect(systemPrompt).not.toContain('Do not spawn thinker-gpt')
      expect(systemPrompt).not.toContain('escalation path')
    },
  )
})

describe('base2 product branding', () => {
  const CREDITS_LINE =
    "Every prompt sent consumes the user's credits, which is calculated based on the API cost of the models used."

  test('lite is branded as paid Codebuff, not as Freebuff', () => {
    // Lite charges credits. It used to inherit free mode's branding and tell
    // paying users they were coding with AI for free.
    const systemPrompt = createBase2('lite').systemPrompt

    expect(systemPrompt).toContain('the product, Codebuff')
    expect(systemPrompt).toContain('# Codebuff Meta-information')
    expect(systemPrompt).not.toContain('Freebuff')
    expect(systemPrompt).not.toContain('for free')
    expect(systemPrompt).not.toContain('freebuff.com')
  })

  test('lite gets the paid meta-information block every other paid mode gets', () => {
    const lite = createBase2('lite').systemPrompt

    expect(lite).toContain(CREDITS_LINE)
    expect(lite).toContain('"/usage"')
    expect(lite).toContain('codebuff.com/docs')
    // The mode list the block recites should name lite as well.
    expect(lite).toContain('DEFAULT, LITE, MAX, or PLAN')
    // And lite introduces itself exactly as the other paid modes do.
    expect(lite!.split('\n')[0]).toBe(
      createBase2('default').systemPrompt!.split('\n')[0],
    )
  })

  test('free mode keeps its Freebuff branding', () => {
    const free = createBase2('free').systemPrompt

    expect(free).toContain('the product, Freebuff')
    expect(free).toContain('to code with AI for free')
    expect(free).toContain('# Freebuff Meta-information')
    expect(free).toContain('freebuff.com')
    expect(free).not.toContain(CREDITS_LINE)
    expect(free).not.toContain('"/usage"')
  })

  test('rebranding lite left its lean orchestration shape untouched', () => {
    const lite = createBase2('lite')
    const free = createBase2('free')
    const paid = createBase2('default')

    // Lean modes edit directly instead of proposing edits.
    expect(lite.toolNames).not.toContain('propose_str_replace')
    expect(lite.toolNames).not.toContain('propose_write_file')
    expect(free.toolNames).not.toContain('propose_str_replace')
    expect(paid.toolNames).toContain('propose_str_replace')

    // And they review with the cheap reviewer rather than spawning an editor.
    expect(lite.spawnableAgents).toContain('code-reviewer-lite')
    expect(lite.spawnableAgents).not.toContain('editor')
  })
})

describe('base2 provider routing', () => {
  test('every mode refuses providers that may keep the data', () => {
    // The privacy policy's no-training promise is made to every user, so paid
    // modes must assert this too, not just the free tier. Verified against
    // OpenRouter: deny still serves luna, gemini-pro, minimax-m3 and opus.
    for (const mode of ['default', 'free', 'lite', 'max', 'fast'] as const) {
      expect(createBase2(mode).providerOptions).toMatchObject({
        data_collection: 'deny',
      })
    }
  })

  test('Claude additionally comes from Bedrock', () => {
    expect(createBase2('default').providerOptions).toEqual({
      only: ['amazon-bedrock'],
      data_collection: 'deny',
    })
    // Bedrock serves no OpenAI or MiMo endpoint, so non-Claude models get the
    // deny without a provider pin.
    expect(createBase2('lite').providerOptions).toEqual({
      data_collection: 'deny',
    })
    expect(
      createBase2('default', { model: FREEBUFF_MIMO_V25_PRO_MODEL_ID })
        .providerOptions,
    ).toEqual({ data_collection: 'deny' })
  })

  test('an explicit providerOptions override wins', () => {
    expect(
      createBase2('free', { providerOptions: {} }).providerOptions,
    ).toEqual({})
  })
})

describe('base2 optional tools', () => {
  test('omits gravity_index and its instruction together', () => {
    const base2 = createBase2('free', { noGravityIndex: true })

    expect(base2.toolNames).not.toContain('gravity_index')
    expect(base2.systemPrompt).not.toContain('gravity_index')
  })
})

describe('base2 context pruning', () => {
  const getContextPrunerParams = (
    mode: Parameters<typeof createBase2>[0],
    options?: Parameters<typeof createBase2>[1],
    params?: Record<string, unknown>,
  ) => {
    const base2 = createBase2(mode, options)
    const generator = base2.handleSteps!({ params } as any)
    const step = generator.next().value as any
    return step.input.params
  }

  const getSerializedContextPrunerParams = (
    mode: Parameters<typeof createBase2>[0],
    options?: Parameters<typeof createBase2>[1],
  ) => {
    const base2 = createBase2(mode, options)
    const handleStepsString = base2.handleSteps!.toString()
    expect(handleStepsString).toMatch(/^function\*\s*\(/)
    const isolatedHandleSteps = new Function(
      `return (${handleStepsString})`,
    )() as NonNullable<typeof base2.handleSteps>
    const generator = isolatedHandleSteps({ params: undefined } as any)
    const step = generator.next().value as any
    return step.input.params
  }

  test('free mode (MiniMax M3) defaults context pruning to 400k tokens', () => {
    const base2 = createBase2('free')
    const generator = base2.handleSteps!({ params: undefined } as any)

    expect(generator.next().value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: {
        agent_type: 'context-pruner',
        params: {
          maxContextLength: 400_000,
          cacheExpiryMs: 30 * 60 * 1000,
        },
      },
      includeToolCall: false,
    })
  })

  test('free Kimi mode defaults context pruning to 250k tokens', () => {
    expect(
      getContextPrunerParams('free', { model: FREEBUFF_KIMI_MODEL_ID }),
    ).toEqual({
      maxContextLength: 250_000,
      cacheExpiryMs: 30 * 60 * 1000,
    })
  })

  test('free non-MiniMax/Kimi models default context pruning to 400k tokens', () => {
    expect(
      getContextPrunerParams('free', {
        model: FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
      }),
    ).toEqual({
      maxContextLength: 400_000,
      cacheExpiryMs: 30 * 60 * 1000,
    })
  })

  test('free mode preserves explicit context pruning params', () => {
    const base2 = createBase2('free')
    const generator = base2.handleSteps!({
      params: { maxContextLength: 123_000, assistantToolBudget: 10_000 },
    } as any)

    expect(generator.next().value).toMatchObject({
      input: {
        params: {
          maxContextLength: 123_000,
          assistantToolBudget: 10_000,
          cacheExpiryMs: 30 * 60 * 1000,
        },
      },
    })
  })

  test.each(['default', 'lite', 'max', 'fast'] as const)(
    '%s mode defaults context pruning to 400k tokens with a 30-minute cache expiry',
    (mode) => {
      expect(getContextPrunerParams(mode)).toEqual({
        maxContextLength: 400_000,
        cacheExpiryMs: 30 * 60 * 1000,
      })
    },
  )

  test.each([
    [FREEBUFF_KIMI_MODEL_ID, 250_000],
    [FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID, 400_000],
  ] as const)(
    'non-free model %p defaults context pruning to %p tokens',
    (model, maxContextLength) => {
      expect(getContextPrunerParams('default', { model })).toEqual({
        maxContextLength,
        cacheExpiryMs: 30 * 60 * 1000,
      })
    },
  )

  test.each([
    ['free', { model: FREEBUFF_KIMI_MODEL_ID }, 250_000],
    ['free', { model: FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID }, 400_000],
    ['default', { model: FREEBUFF_KIMI_MODEL_ID }, 250_000],
    ['default', { model: FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID }, 400_000],
  ] as const)(
    'serialized %s handleSteps for model %p defaults to %p tokens',
    (mode, options, maxContextLength) => {
      expect(getSerializedContextPrunerParams(mode, options)).toMatchObject({
        maxContextLength,
      })
    },
  )

  test('non-free mode preserves explicit context pruning params', () => {
    expect(
      getContextPrunerParams(
        'default',
        {
          model: FREEBUFF_KIMI_MODEL_ID,
        },
        {
          maxContextLength: 123_000,
          assistantToolBudget: 10_000,
        },
      ),
    ).toEqual({
      maxContextLength: 123_000,
      assistantToolBudget: 10_000,
      cacheExpiryMs: 30 * 60 * 1000,
    })
  })
})

describe('Claude Fable 5 root', () => {
  const fable = createBase2('free', {
    model: FREEBUFF_FABLE_5_MODEL_ID,
  })

  test('reviews with the generic reviewer, not a per-model one', () => {
    // AnyBuff: per-model reviewers were removed; free mode always resolves to
    // the generic code-reviewer.
    expect(fable.spawnableAgents).toContain('code-reviewer')
    expect(fable.spawnableAgents).not.toContain('code-reviewer-fable')
    expect(fable.spawnableAgents).not.toContain('code-reviewer-deepseek-flash')
  })
})
