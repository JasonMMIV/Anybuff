/**
 * Work item 10: the per-turn instructions prompt must be scaffolding, not
 * permanent history. It also has to still reach the model during the turn it
 * was generated for.
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
import { userMessage } from '@codebuff/common/util/messages'
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'

import { loopAgentSteps } from '../run-agent-step'
import { clearAgentGeneratorCache } from '../run-programmatic-step'
import { mockFileContext } from './test-utils'

import type { AgentTemplate } from '../templates/types'
import type { DbSpies } from '@codebuff/common/testing/mocks/database'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { StreamChunk } from '@codebuff/common/types/contracts/llm'

const hasInstructions = (messages: Message[] | undefined) =>
  (messages ?? []).filter((message) =>
    message.tags?.includes('INSTRUCTIONS_PROMPT'),
  )

const historyText = (messages: Message[]): string =>
  messages
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : message.content
            .map((part) => ('text' in part ? part.text : ''))
            .join('\n'),
    )
    .join('\n')

describe('INSTRUCTIONS_PROMPT per-turn TTL', () => {
  let dbSpies: DbSpies
  let runtimeImpl: any
  let capturedMessages: Array<Message[] | undefined>

  const agentTemplate: AgentTemplate = {
    id: 'test-agent',
    displayName: 'Test Agent',
    spawnerPrompt: 'Testing',
    model: 'claude-3-5-sonnet-20241022',
    inputSchema: {},
    outputMode: 'last_message',
    includeMessageHistory: true,
    inheritParentSystemPrompt: false,
    mcpServers: {},
    toolNames: ['read_files', 'end_turn'],
    spawnableAgents: [],
    systemPrompt: 'Test system prompt',
    instructionsPrompt: 'STANDING ORDERS: keep the plan updated.',
    stepPrompt: '',
    handleSteps: undefined,
  } satisfies AgentTemplate as AgentTemplate

  const runTurn = async (agentState: any, prompt: string) => {
    const {
      agentTemplate: _,
      localAgentTemplates: __,
      ...baseRuntimeParams
    } = createTestAgentRuntimeParams()

    runtimeImpl = { ...baseRuntimeParams }
    runtimeImpl.promptAiSdkStream = mock(async function* (
      params: { messages?: Message[] },
    ) {
      capturedMessages.push(params.messages)
      const chunks: StreamChunk[] = [{ type: 'text', text: 'done' }]
      for (const chunk of chunks) yield chunk
      return promptSuccess('mock-message-id')
    })
    runtimeImpl.onResponseChunk = mock(() => {})

    return loopAgentSteps({
      ...runtimeImpl,
      agentType: 'test-agent',
      localAgentTemplates: { 'test-agent': agentTemplate },
      repoId: undefined,
      repoUrl: undefined,
      userInputId: 'test-user-input',
      agentState,
      prompt,
      spawnParams: undefined,
      fingerprintId: 'test-fingerprint',
      fileContext: mockFileContext,
      userId: TEST_USER_ID,
      clientSessionId: 'test-session',
      ancestorRunIds: [],
      signal: new AbortController().signal,
    } as any)
  }

  beforeEach(() => {
    dbSpies = setupDbSpies(createMockDbOperations())
    spyOn(analytics, 'trackEvent').mockImplementation(() => {})
    capturedMessages = []
  })

  afterEach(() => {
    if (runtimeImpl) clearAgentGeneratorCache(runtimeImpl)
    dbSpies.restore()
    mock.restore()
  })

  afterAll(() => {
    clearMockedModules()
  })

  it('does not leave the instructions prompt in the history after a turn', async () => {
    const sessionState = getInitialSessionState(mockFileContext)
    const result = await runTurn(
      {
        ...sessionState.mainAgentState,
        agentId: 'test-agent-id',
        messageHistory: [],
        output: undefined,
        stepsRemaining: 5,
      },
      'first question',
    )

    expect(hasInstructions(result.agentState.messageHistory)).toHaveLength(0)
    expect(historyText(result.agentState.messageHistory)).toContain(
      'first question',
    )
  })

  it('does not accumulate across two turns and still sends instructions each turn', async () => {
    const sessionState = getInitialSessionState(mockFileContext)
    const first = await runTurn(
      {
        ...sessionState.mainAgentState,
        agentId: 'test-agent-id',
        messageHistory: [],
        output: undefined,
        stepsRemaining: 5,
      },
      'first question',
    )
    const second = await runTurn(first.agentState, 'second question')

    expect(hasInstructions(second.agentState.messageHistory)).toHaveLength(0)
    expect(historyText(second.agentState.messageHistory)).toContain(
      'first question',
    )
    expect(historyText(second.agentState.messageHistory)).toContain(
      'second question',
    )
    // Each model request carried exactly the current turn's copy.
    expect(capturedMessages).toHaveLength(2)
    expect(hasInstructions(capturedMessages[0])).toHaveLength(1)
    expect(hasInstructions(capturedMessages[1])).toHaveLength(1)
  })

  it('keeps an ordinary user message in the history', async () => {
    const sessionState = getInitialSessionState(mockFileContext)
    const result = await runTurn(
      {
        ...sessionState.mainAgentState,
        agentId: 'test-agent-id',
        messageHistory: [userMessage('earlier turn')],
        output: undefined,
        stepsRemaining: 5,
      },
      'hello',
    )

    expect(historyText(result.agentState.messageHistory)).toContain(
      'earlier turn',
    )
  })
})
