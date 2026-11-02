/**
 * `/compact` command guard (context-compaction plan Phase 0).
 *
 * A manual `/compact` replaces the whole conversation with the model's
 * summary. Without a guard, a silent empty stop, a reasoning-only / think-only
 * response, a tool-call-only step, or a step that carried a recovery note all
 * replaced the history with an empty summary — and a `warn` log is invisible
 * in the chat UI. These cases pin the guard, the user-visible
 * `compact_skipped` event, and the deliberate no-tag shape of the successful
 * replacement (plan D1).
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
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'

import { COMPACT_SKIPPED_MESSAGE } from '@codebuff/common/constants/compaction'

import { compactMessages } from '../compact-history'
import { loopAgentSteps } from '../run-agent-step'
import { clearAgentGeneratorCache } from '../run-programmatic-step'
import { createToolCallChunk, mockFileContext } from './test-utils'

import type { AgentTemplate } from '../templates/types'
import type { DbSpies } from '@codebuff/common/testing/mocks/database'
import type { StreamChunk } from '@codebuff/common/types/contracts/llm'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'

const SUMMARY_PREFIX =
  'The following is a summary of the conversation between you and the user.'

const textOf = (message: Message): string =>
  Array.isArray(message.content)
    ? message.content
        .map((part) => ('text' in part ? part.text : ''))
        .join('\n')
    : String(message.content ?? '')

describe('/compact command guard', () => {
  let dbSpies: DbSpies
  let runtimeImpl: any
  let events: Array<string | PrintModeEvent>

  const baseTemplate: AgentTemplate = {
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
    instructionsPrompt: '',
    stepPrompt: '',
    handleSteps: undefined,
  } satisfies AgentTemplate as AgentTemplate

  const runCompact = async (chunks: StreamChunk[]) => {
    const {
      agentTemplate: _,
      localAgentTemplates: __,
      ...baseRuntimeParams
    } = createTestAgentRuntimeParams()

    runtimeImpl = { ...baseRuntimeParams }
    runtimeImpl.promptAiSdkStream = mock(async function* () {
      for (const chunk of chunks) {
        yield chunk
      }
      return promptSuccess('mock-message-id')
    })
    runtimeImpl.requestFiles = mock(
      async ({ filePaths }: { filePaths: string[] }) =>
        Object.fromEntries(
          filePaths.map((filePath) => [filePath, `contents of ${filePath}`]),
        ),
    )
    events = []
    runtimeImpl.onResponseChunk = mock((chunk: string | PrintModeEvent) => {
      events.push(chunk)
    })

    const sessionState = getInitialSessionState(mockFileContext)
    return loopAgentSteps({
      ...runtimeImpl,
      agentType: 'test-agent',
      localAgentTemplates: { 'test-agent': baseTemplate },
      repoId: undefined,
      repoUrl: undefined,
      userInputId: 'test-user-input',
      agentState: {
        ...sessionState.mainAgentState,
        agentId: 'test-agent-id',
        messageHistory: [
          userMessage('earlier turn: fix the login bug'),
          assistantMessage('I fixed the login bug in auth.ts.'),
        ],
        output: undefined,
        stepsRemaining: 5,
      },
      prompt: '/compact',
      spawnParams: undefined,
      fingerprintId: 'test-fingerprint',
      fileContext: mockFileContext,
      userId: TEST_USER_ID,
      clientSessionId: 'test-session',
      ancestorRunIds: [],
      signal: new AbortController().signal,
    } as any)
  }

  const historyText = (messages: Message[]): string =>
    messages.map(textOf).join('\n')

  const compactionEvents = () =>
    events.filter(
      (
        event,
      ): event is Extract<PrintModeEvent, { type: 'context_compaction' }> =>
        typeof event !== 'string' && event.type === 'context_compaction',
    )

  beforeEach(() => {
    dbSpies = setupDbSpies(createMockDbOperations())
    spyOn(analytics, 'trackEvent').mockImplementation(() => {})
  })

  afterEach(() => {
    if (runtimeImpl) clearAgentGeneratorCache(runtimeImpl)
    dbSpies.restore()
    mock.restore()
  })

  afterAll(() => {
    clearMockedModules()
  })

  it('does not overwrite the history on a silent empty stop', async () => {
    const result = await runCompact([])
    const history = result.agentState.messageHistory

    expect(historyText(history)).not.toContain(SUMMARY_PREFIX)
    expect(historyText(history)).toContain('earlier turn: fix the login bug')

    const compaction = compactionEvents()
    expect(compaction).toHaveLength(1)
    expect(compaction[0]).toMatchObject({
      action: 'compact_skipped',
      message: COMPACT_SKIPPED_MESSAGE,
    })
  })

  it('does not overwrite the history on a reasoning-only response', async () => {
    const result = await runCompact([
      { type: 'reasoning', text: 'thinking about the summary' },
    ])
    const history = result.agentState.messageHistory

    expect(historyText(history)).not.toContain(SUMMARY_PREFIX)
    expect(historyText(history)).toContain('earlier turn: fix the login bug')
    expect(
      history.some(
        (message) =>
          message.role === 'assistant' &&
          Array.isArray(message.content) &&
          message.content.some((part) => part.type === 'reasoning'),
      ),
    ).toBe(true)
    expect(compactionEvents()).toHaveLength(1)
  })

  it('does not overwrite the history on an orphan think tag', async () => {
    const result = await runCompact([{ type: 'text', text: '</think>' }])
    const history = result.agentState.messageHistory

    expect(historyText(history)).not.toContain(SUMMARY_PREFIX)
    expect(historyText(history)).toContain('earlier turn: fix the login bug')
    expect(compactionEvents()).toHaveLength(1)
  })

  it('does not overwrite the history when the model only calls tools', async () => {
    const result = await runCompact([
      createToolCallChunk('read_files', { paths: ['src/auth.ts'] }),
      createToolCallChunk('end_turn', {}),
    ])
    const history = result.agentState.messageHistory

    expect(historyText(history)).not.toContain(SUMMARY_PREFIX)
    expect(historyText(history)).toContain('earlier turn: fix the login bug')
    expect(history.some((message) => message.role === 'tool')).toBe(true)
    expect(compactionEvents()).toHaveLength(1)
  })

  it('does not overwrite a full summary when the step carried a tool error', async () => {
    const result = await runCompact([
      { type: 'text', text: 'The login bug is fixed.' },
      { type: 'error', message: 'bad tool input' },
    ])
    const history = result.agentState.messageHistory

    expect(historyText(history)).not.toContain(SUMMARY_PREFIX)
    expect(historyText(history)).toContain('earlier turn: fix the login bug')
    expect(
      history.some(
        (message) =>
          message.role === 'user' && message.tags?.includes('TOOL_CALL_ERROR'),
      ),
    ).toBe(true)
    expect(compactionEvents()).toHaveLength(1)
  })

  it('replaces the history with an untagged summary on a clean summary', async () => {
    const result = await runCompact([
      { type: 'text', text: 'Earlier we fixed the login bug in auth.ts.' },
    ])
    const history = result.agentState.messageHistory

    expect(history).toHaveLength(1)
    expect(historyText(history)).toContain(SUMMARY_PREFIX)
    expect(historyText(history)).toContain('Earlier we fixed the login bug')
    expect(history[0]?.tags ?? []).not.toContain('CONVERSATION_SUMMARY')
    expect(historyText(history)).not.toContain('<conversation_summary>')
    expect(compactionEvents()).toHaveLength(0)
  })

  it('keeps the /compact prose as an ordinary user entry on the next compaction', async () => {
    const result = await runCompact([
      { type: 'text', text: 'Earlier we fixed the login bug in auth.ts.' },
    ])
    const compacted = compactMessages({
      messages: [
        ...result.agentState.messageHistory,
        assistantMessage('Next we should add regression tests.'),
      ],
    })

    expect(compacted.summaryText).toContain('Earlier we fixed the login bug')
    // Not recognized as a previous summary: the untagged prose enters through
    // the ordinary user branch instead of being parsed into an empty memory.
    expect(compacted.stats.previous_summary_entry_count).toBe(0)
  })
})
