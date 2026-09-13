import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { afterEach, describe, expect, it, mock } from 'bun:test'

import { mockFileContext } from './test-utils'
import {
  clearProgrammaticRunState,
  runProgrammaticStep,
} from '../run-programmatic-step'

import type { AgentTemplate } from '@codebuff/common/types/agent-template'

// ADR-28 wiring lock. The unit tests in agents/__tests__/code-reviewer.test.ts
// hand a mock agentState to handleSteps and assert on the same object — they
// prove the generator curates what it is handed, but NOT that the runtime
// hands handleSteps the live agentState it later uses to build the STEP
// request (run-agent-step builds the prompt from agentState.messageHistory
// after runProgrammaticStep is awaited and its agentState merged back). If an
// upstream refactor ever passes a copy at that seam, the reviewer's
// reasoning strip silently no-ops with every unit test still green.
//
// This test drives the REAL runProgrammaticStep driver and asserts the
// passed-in live agentState comes back curated. The strip generator is
// redeclared inline (same logic shape as createReviewer()'s handleSteps in
// agents/reviewer/code-reviewer.ts) because agent-runtime tests cannot
// import from the agents directory.
describe('programmatic handleSteps history curation wiring', () => {
  const usedRunIds: string[] = []

  afterEach(() => {
    // The driver keys its generator cache by runId — release the entries so
    // the module-level map stays clean across the suite.
    for (const runId of usedRunIds) {
      clearProgrammaticRunState(runId)
    }
    usedRunIds.length = 0
  })

  const mockLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }

  // Unique runId per test so the generator is created (and the strip runs)
  // against each test's own history.
  const createAgentState = (runId: string) => {
    usedRunIds.push(runId)
    const sessionState = getInitialSessionState(mockFileContext)
    const agentState = sessionState.mainAgentState
    agentState.runId = runId
    return agentState
  }

  // Same strip shape as agents/reviewer/code-reviewer.ts (ADR-28): drop
  // reasoning parts from assistant messages outside the final assistant
  // run, rebuild objects (never mutate the shared originals), keep the final
  // run verbatim for the Claude thinking replay contract.
  const stripHandleSteps = function* ({ agentState }: any) {
    const history = agentState.messageHistory
    let lastRunEnd = -1
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'assistant') {
        lastRunEnd = i
        break
      }
    }
    let lastRunStart = lastRunEnd
    while (
      lastRunStart > 0 &&
      history[lastRunStart - 1].role === 'assistant'
    ) {
      lastRunStart--
    }
    agentState.messageHistory = history.flatMap(
      (message: any, i: number) => {
        if (
          message.role !== 'assistant' ||
          i >= lastRunStart ||
          !Array.isArray(message.content)
        ) {
          return [message]
        }
        const content = message.content.filter(
          (part: any) => part.type !== 'reasoning',
        )
        if (content.length === message.content.length) return [message]
        if (content.length === 0) return []
        return [{ ...message, content }]
      },
    )
    yield 'STEP'
  }

  const createStripTemplate = (): AgentTemplate => ({
    id: 'history-curation-strip-agent',
    displayName: 'History Curation Strip Agent',
    outputMode: 'last_message' as const,
    inputSchema: {
      prompt: {
        safeParse: () => ({ success: true }),
      } as unknown as AgentTemplate['inputSchema']['prompt'],
    },
    spawnerPrompt: '',
    model: '',
    includeMessageHistory: true,
    inheritParentSystemPrompt: false,
    mcpServers: {},
    toolNames: [],
    spawnableAgents: [],
    systemPrompt: '',
    handleSteps: stripHandleSteps,
  })

  const runStripAgent = (agentState: any, prompt: string) =>
    runProgrammaticStep({
      ...TEST_AGENT_RUNTIME_IMPL,
      addAgentStep: mock(async () => ({})) as any,
      agentState,
      clientSessionId: 'test-session',
      fingerprintId: 'test-fingerprint',
      handleStepsLogChunk: mock(() => {}),
      localAgentTemplates: {},
      logger: mockLogger as any,
      onResponseChunk: () => {},
      prompt,
      repoId: undefined,
      repoUrl: undefined,
      sendAction: mock(() => {}),
      stepNumber: 0,
      stepsComplete: false,
      system: 'test system',
      template: createStripTemplate(),
      toolCallParams: {},
      userId: TEST_USER_ID,
      userInputId: 'test-input',
    } as any)

  it('curates the live agentState through the real driver', async () => {
    const agentState = createAgentState('history-curation-wiring-1')

    agentState.messageHistory = [
      { role: 'user', content: [{ type: 'text', text: 'Fix the login bug' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'secret author deliberation' },
          { type: 'text', text: 'Fixing it now' },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'abandoned tangent' }],
      },
      { role: 'user', content: [{ type: 'text', text: 'Now review' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'final run reasoning' },
          { type: 'text', text: 'Ready for review' },
        ],
      },
    ]
    const originalHistory = agentState.messageHistory
    const originalSnapshot = JSON.stringify(originalHistory)

    const result = await runStripAgent(agentState, 'Review the changes')

    // The strip ran against the live object the driver holds — this is the
    // wiring the unit tests cannot see.
    const curated = agentState.messageHistory
    expect(curated).not.toBe(originalHistory)
    // Reasoning-only turn dropped; the old assistant keeps its visible text.
    expect(curated).toHaveLength(4)
    expect(
      (curated[1].content as Array<{ type: string }>).map((p) => p.type),
    ).toEqual(['text'])
    // Final assistant run replays verbatim — same object, reasoning kept.
    expect(curated[3]).toBe(originalHistory[4])
    expect(
      (curated[3].content as Array<{ type: string }>)[0].type,
    ).toBe('reasoning')

    // The array the child was spawned from is untouched (ADR-26 parent line).
    expect(JSON.stringify(originalHistory)).toBe(originalSnapshot)

    // The returned state shows the curation too, and the turn is not ended
    // (the generator yielded STEP and the driver broke out of its loop).
    expect(
      (
        result.agentState.messageHistory[1].content as Array<{
          type: string
        }>
      )[0].type,
    ).toBe('text')
    expect(result.endTurn).toBe(false)
  })

  it('passes a reasoning-free history through the real driver unchanged', async () => {
    const agentState = createAgentState('history-curation-wiring-2')

    agentState.messageHistory = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
    ]

    const result = await runStripAgent(agentState, 'Review the changes')

    expect(agentState.messageHistory).toHaveLength(2)
    expect(
      (agentState.messageHistory[1].content as Array<{ type: string }>)[0]
        .type,
    ).toBe('text')
    expect(result.endTurn).toBe(false)
  })
})
