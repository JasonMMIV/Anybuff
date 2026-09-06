/**
 * B2 (AnyBuff P1): the runtime's compactContext path must compact at the
 * §3.3 trigger — min(0.7·W, W − reserve(W, out)) — not at the raw window.
 * Before B2, `maxContextLength` received the raw resolved window, so the
 * first signal of an oversized request was the provider's overflow error
 * (path-B bug, plan §2.1).
 *
 * The decision layer (maybeCompactHistory) is proven by compact-history.test.ts;
 * the formula is proven by common's context-trim.test.ts. Here we prove
 * loopAgentSteps wires the converted value through, using a measured history
 * against a small window (runLoop mirrors compact-context-loop.test.ts).
 */

import * as analytics from '@codebuff/common/analytics'
import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { createTestAgentRuntimeParams } from '@codebuff/common/testing/fixtures/agent-runtime'
import { clearMockedModules } from '@codebuff/common/testing/mock-modules'
import {
  createMockDbOperations,
  setupDbSpies,
} from '@codebuff/common/testing/mocks/database'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { promptSuccess } from '@codebuff/common/util/error'
import { assistantMessage, userMessage } from '@codebuff/common/util/messages'
import {
  toCompactionTriggerTokens,
  UNKNOWN_MODEL_CONTEXT_FALLBACK,
} from '@codebuff/common/util/context-trim'
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from 'bun:test'

import { loopAgentSteps } from '../run-agent-step'
import { clearAgentGeneratorCache } from '../run-programmatic-step'
import { countTokensMessages } from '../util/token-counter'
import { createToolCallChunk, mockFileContext } from './test-utils'

import type { AgentTemplate } from '../templates/types'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'

const baseTemplate: AgentTemplate = {
  id: 'test-agent',
  displayName: 'Test Agent',
  spawnerPrompt: 'Testing',
  model: 'test/window-model',
  inputSchema: {},
  outputMode: 'last_message',
  includeMessageHistory: true,
  inheritParentSystemPrompt: false,
  mcpServers: {},
  toolNames: ['end_turn'],
  spawnableAgents: [],
  systemPrompt: 'Test system prompt',
  instructionsPrompt: '',
  stepPrompt: '',
  handleSteps: undefined,
  // Context-limit trigger only: the opportunistic cache-expiry trigger is
  // disabled so the assertions isolate the B2 conversion under test.
  compactContext: { cacheExpiryMs: null },
} satisfies AgentTemplate as AgentTemplate

/** A single measured pair; the loop adds one live user prompt on top. */
const fillerPair = (index: number): Message[] => [
  userMessage(`filler user ${index} ${'x'.repeat(120)}`),
  assistantMessage(`filler assistant ${index} ${'y'.repeat(120)}`),
]

/**
 * The loop counts history + live prompt + system + tools; the live prompt is
 * what promptCacheGapMs measures from, so it needs the USER_PROMPT tag with a
 * sentAt far in the past — otherwise the opportunistic trigger could also fire
 * and muddy the context-limit assertion.
 */
const LIVE_PROMPT = {
  role: 'user' as const,
  content: [{ type: 'text' as const, text: 'the live question' }],
  tags: ['USER_PROMPT' as const],
  sentAt: Date.now() + 10 * 60 * 1_000, // live prompt written "in the future"
}

/** Same token count the loop computes for the compaction decision. */
const measuredTokens = (history: Message[]): number =>
  countTokensMessages([...history, LIVE_PROMPT as unknown as Message])

const runLoop = async (params: {
  contextWindow: number
  outputTokens?: number
  history: Message[]
}): Promise<{
  history: Message[]
  runtimeImpl: any
  /** The loop's own context-meter reading (used: max) from the step end. */
  contextMeter: { used: number; max: number } | null
}> => {
  const {
    agentTemplate: _,
    localAgentTemplates: __,
    ...baseRuntimeParams
  } = createTestAgentRuntimeParams()

  const runtimeImpl: any = {
    ...baseRuntimeParams,
    resolveContextWindow: () => params.contextWindow,
    resolveContextOutputTokens: () => params.outputTokens,
  }
  runtimeImpl.promptAiSdkStream = async function* (_: any) {
    yield { type: 'text' as const, text: 'ok' }
    yield createToolCallChunk('end_turn', {})
    return promptSuccess('mock-message-id')
  }

  let contextMeter: { used: number; max: number } | null = null
  const sessionState = getInitialSessionState(mockFileContext)
  const result = await loopAgentSteps({
    ...runtimeImpl,
    agentType: baseTemplate.id,
    localAgentTemplates: { [baseTemplate.id]: baseTemplate },
    repoId: undefined,
    repoUrl: undefined,
    userInputId: 'test-user-input',
    agentState: {
      ...sessionState.mainAgentState,
      agentId: 'test-agent-id',
      messageHistory: params.history,
      output: undefined,
      stepsRemaining: 1,
    },
    prompt: undefined,
    spawnParams: undefined,
    fingerprintId: 'test-fingerprint',
    fileContext: mockFileContext,
    userId: TEST_USER_ID,
    clientSessionId: 'test-session',
    ancestorRunIds: [],
    onResponseChunk: (chunk: any) => {
      if (chunk && typeof chunk === 'object' && chunk.type === 'context_window') {
        contextMeter = { used: chunk.used, max: chunk.max }
      }
    },
    signal: new AbortController().signal,
  } as any)
  return { history: result.agentState.messageHistory, runtimeImpl, contextMeter }
}

const textOf = (history: Message[]): string =>
  JSON.stringify(history.map((m) => m.content))

describe('B2: compaction trigger conversion in loopAgentSteps', () => {
  let dbSpies: ReturnType<typeof setupDbSpies>
  let lastRuntimeImpl: any

  beforeEach(() => {
    dbSpies = setupDbSpies(createMockDbOperations())
    spyOn(analytics, 'trackEvent').mockImplementation(() => {})
  })
  afterEach(() => {
    if (lastRuntimeImpl) clearAgentGeneratorCache(lastRuntimeImpl)
    if (dbSpies) dbSpies.restore()
  })
  afterAll(() => {
    clearMockedModules()
  })

  it('compacts at min(0.7·W, W−reserve), not at the raw window', async () => {
    // The harness carries ~750 tokens of fixed overhead (system prompt,
    // tool schemas, live prompt). With a 5k window the reserve's 8k floor
    // clamps to 0.5·W = 2_500, so trigger = min(3_500, 2_500) = 2_500 — a
    // (trigger, W) band still exists for the filler to cross.
    const contextWindow = 5_000
    const trigger = toCompactionTriggerTokens(contextWindow)
    expect(trigger).toBe(2_500)

    // Grow the history until the loop's own context meter crosses the
    // trigger. The meter is the exact number the compaction decision sees.
    let history: Message[] = []
    let meter: { used: number; max: number } | null = null
    for (;;) {
      const run = await runLoop({ contextWindow, history })
      lastRuntimeImpl = run.runtimeImpl
      meter = run.contextMeter
      expect(meter).not.toBeNull()
      if (meter!.used > trigger) {
        expect(textOf(run.history)).toContain('<conversation_summary>')
        // Sanity: the same history fits inside the raw window — pre-B2 this
        // run would NOT have compacted, because maxContextLength was W.
        expect(meter!.used).toBeLessThan(contextWindow)
        return
      }
      history = [...history, ...fillerPair(history.length / 2)]
    }
  })

  it('leaves the history alone below the trigger even close to the window', async () => {
    // Same window as above: trigger = 2_500, so a history reading in the
    // (trigger, W) band would have compacted pre-B2 (W=5k) but must not now.
    const contextWindow = 5_000
    const trigger = toCompactionTriggerTokens(contextWindow)
    expect(trigger).toBe(2_500)

    // Two filler pairs: the loop's meter reads below the trigger, and below
    // the raw window too.
    const history = [...fillerPair(0), ...fillerPair(1)]
    const { history: untouched, runtimeImpl, contextMeter } = await runLoop({
      contextWindow,
      history,
    })
    lastRuntimeImpl = runtimeImpl
    expect(contextMeter).not.toBeNull()
    expect(contextMeter!.used).toBeLessThan(trigger)
    expect(textOf(untouched)).not.toContain('<conversation_summary>')
  })

  it('a declared output reserve pulls the trigger down further', () => {
    // W=100k with a huge declared output: reserve caps at 0.5·W → trigger 50k,
    // strictly below the 0.7·W = 70k flat fraction.
    expect(toCompactionTriggerTokens(100_000)).toBe(70_000)
    expect(toCompactionTriggerTokens(100_000, 100_000)).toBe(50_000)
    // The 64k output-reserve cap keeps larger outputs from shrinking it more.
    expect(toCompactionTriggerTokens(100_000, 1_000_000)).toBe(50_000)
  })

  it('unknown-window fallback applies the trigger formula (1M → 700k)', () => {
    expect(UNKNOWN_MODEL_CONTEXT_FALLBACK).toBe(1_000_000)
    expect(toCompactionTriggerTokens(UNKNOWN_MODEL_CONTEXT_FALLBACK)).toBe(700_000)
  })
})
