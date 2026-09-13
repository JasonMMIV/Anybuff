import { OPUS_MODEL, publisher } from '../constants'
import {
  PLACEHOLDER,
  type SecretAgentDefinition,
} from '../types/secret-agent-definition'

import type { Model } from '@codebuff/common/old-constants'

export const createReviewer = (
  model: Model,
): Omit<SecretAgentDefinition, 'id'> => ({
  model,
  displayName: 'Nit Pick Nick',
  spawnerPrompt:
    'Reviews file changes and responds with critical feedback. Use this after making any significant change to the codebase; otherwise, no need to use this agent for minor changes since it takes a second.',
  inputSchema: {
    prompt: {
      type: 'string',
      description: 'What should be reviewed. Be brief.',
    },
  },
  outputMode: 'last_message',
  toolNames: [],
  spawnableAgents: [],

  // AnyBuff fix (ADR): a no-tool reviewer must NOT inherit the parent's system
  // prompt or tool surface. With inheritParentSystemPrompt: true the runtime
  // (run-agent-step.ts useParentTools) hands the reviewer the parent's full
  // tool set (spawn_agents, code_reviewer, think_deeply, ...) and the parent's
  // system prompt, whose "Spawn a code-reviewer" instructions make the reviewer
  // mimic the orchestrator — it then calls tools it doesn't have and every call
  // bounces with "Tool `X` is not currently available" (tool-executor 338/703),
  // and it ends up echoing the inherited message history instead of reviewing.
  inheritParentSystemPrompt: false,
  includeMessageHistory: true,

  instructionsPrompt: `You are a subagent that reviews code changes and gives helpful critical feedback. Do not use any tools. For reference, here is the original user request:
<user_message>
${PLACEHOLDER.USER_INPUT_PROMPT}
</user_message>

NOTE: The conversation history is intentionally curated for review. The author's internal reasoning/thinking is omitted; user requests, visible actions, tool results, and file changes are shown as they happened.

# Task

Your task is to provide helpful critical feedback on the last file changes made by the assistant. You should find ways to improve the code changes made recently in the above conversation.

Be brief: If you don't have much critical feedback, simply say it looks good in one sentence. No need to include a section on the good parts or "strengths" of the changes -- we just want the critical feedback for what could be improved.

NOTE: You cannot make any changes directly! DO NOT CALL ANY TOOLS! You can only suggest changes.

Before providing your review, use <think></think> tags to think through the code changes and identify any issues or improvements.

# Guidelines

- Focus on giving feedback that will help the assistant get to a complete and correct solution as the top priority.
- Make sure all the requirements in the user's message are addressed. You should call out any requirements that are not addressed -- advocate for the user!
- Try to keep any changes to the codebase as minimal as possible.
- Simplify any logic that can be simplified.
- Where a function can be reused, reuse it and do not create a new one.
- Make sure that no new dead code is introduced.
- Make sure there are no missing imports.
- Make sure no sections were deleted that weren't supposed to be deleted.
- Make sure the new code matches the style of the existing code.
- Make sure there are no unnecessary try/catch blocks. Prefer to remove those.

Be extremely concise.`,

  // ADR-28: blind to the author's monologue, not to the facts. Before the
  // first STEP, replace this subagent's own messageHistory with a curated
  // copy that strips `reasoning` parts from assistant messages — the
  // reviewer then judges user requests, visible text, tool calls and tool
  // results (diffs, test output) rather than the author's self-narrative.
  // The last assistant run stays verbatim: the wire layer merges adjacent
  // assistant messages and the latest turn's thinking blocks must replay
  // unmodified (Claude 400s otherwise — same boundary semantics as
  // splitTail's ADR-26 guard). Message objects are shared with the parent's
  // replay, so edits rebuild new objects on a fresh array; never mutate in
  // place — the parent line keeps its reasoning (ADR-26 governs the parent
  // line, not this child-side curation). A reasoning-only turn drops
  // entirely: an empty assistant content array is a wire hazard.
  // The stale contextTokenCount after the shrink is harmless for a
  // one-step no-tool reviewer, but re-estimate it if this agent ever
  // gains tools or multi-step handleSteps.
  handleSteps: function* ({ agentState }) {
    const history = agentState.messageHistory
    // The final assistant run = the last assistant message plus any
    // immediately-preceding contiguous assistant messages (they merge into
    // one wire message, so the replay unit is the whole run).
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
    agentState.messageHistory = history.flatMap((message, i) => {
      if (
        message.role !== 'assistant' ||
        i >= lastRunStart ||
        !Array.isArray(message.content)
      ) {
        return [message]
      }
      const content = message.content.filter(
        (part) => part.type !== 'reasoning',
      )
      if (content.length === message.content.length) return [message]
      if (content.length === 0) return []
      return [{ ...message, content }]
    })
    yield 'STEP'
  },
})

const definition: SecretAgentDefinition = {
  id: 'code-reviewer',
  publisher,
  ...createReviewer(OPUS_MODEL),
  providerOptions: {
    only: ['amazon-bedrock'],
  },
}

export default definition
