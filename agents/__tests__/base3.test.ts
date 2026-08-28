import {
  hasFreebuffRootSystemPromptOpening,
} from '@codebuff/common/constants/free-agents'
import { describe, test, expect } from 'bun:test'

import base3, { createBase3, createBase3CliRoot } from '../base3'
import base3Evals from '../base3-evals'
import base3Lite from '../base3-lite'

/**
 * The base3 roots that still ship in AnyBuff.
 *
 * `base3` is Codebuff's DEFAULT mode (also the desktop thread harness base);
 * `base3-lite` is the paid LITE mode on a cheaper model; `base3-evals` is the
 * buffbench arm. The Freebuff per-model roots (`base3-free-*`) were removed —
 * AnyBuff routes models through anybuff.json (BYOK) instead of a root per
 * model.
 *
 * What makes base3 cheaper rides on the DEFINITION, not the call site — the
 * runtime reads `windowedFileReads` and `compactContext` straight off the agent
 * template. A root that loses one keeps working and quietly costs base2 money
 * again.
 */
const RETAINED_ROOTS = [base3, base3Lite, base3Evals]

describe('base3 roots', () => {
  test('keeps the efficiency flags the runtime reads', () => {
    expect(RETAINED_ROOTS.length).toBe(3)
    for (const agent of RETAINED_ROOTS) {
      // Windowed reads + the 100-entry glob cap + search-first tool wording.
      expect(agent.windowedFileReads).toBe(true)
      // Mechanical compaction in-process, instead of spawning context-pruner.
      expect(agent.compactContext).toBe(true)
      // Single loop: no subagents at all, which is what the harness IS.
      expect(agent.spawnableAgents ?? []).toEqual([])
      expect(agent.toolNames ?? []).not.toContain('spawn_agents')
      // No per-turn instructions prompt: re-injecting one after every user
      // message breaks the prompt cache the harness is built to keep warm.
      expect(agent.instructionsPrompt).toBeUndefined()
    }
  })

  test('opens with a prompt the free-mode gate accepts', () => {
    // The appendix is appended, never prepended: the chat-completions gate
    // requires a canonical opening at byte 0, so prepending 403s every turn.
    for (const agent of RETAINED_ROOTS) {
      expect(hasFreebuffRootSystemPromptOpening(agent.systemPrompt!)).toBe(true)
    }
  })

  test('leaves the bare harness alone, so Desktop does not inherit CLI tools', () => {
    // freebuff-desktop builds THREAD_AGENT_TOOLS by unioning
    // createBase3().toolNames with its own extras, so anything added to the
    // base factory lands on every Desktop thread silently.
    expect(createBase3().toolNames).toEqual([
      'read_files',
      'str_replace',
      'write_file',
      'run_terminal_command',
      'code_search',
      'glob',
      'list_directory',
      'write_todos',
    ])
  })

  test('noAskUser drops the human tools from the prompt as well as the toolset', () => {
    // The two have to move together. A prompt telling the model to call
    // ask_user when the tool is absent is a wasted step every eval run.
    const withUser = createBase3CliRoot()
    const withoutUser = createBase3CliRoot({ noAskUser: true })

    expect(withUser.toolNames).toContain('ask_user')
    expect(withUser.toolNames).toContain('suggest_followups')
    expect(withUser.systemPrompt).toContain('ask_user')

    expect(withoutUser.toolNames).not.toContain('ask_user')
    expect(withoutUser.toolNames).not.toContain('suggest_followups')
    expect(withoutUser.systemPrompt).not.toContain('ask_user')
    expect(withoutUser.systemPrompt).not.toContain('suggest_followups')

    // Otherwise identical: the eval variant must stay a like-for-like
    // comparison, not a differently-equipped agent.
    expect(withoutUser.toolNames).toEqual(
      withUser.toolNames!.filter(
        (name) => name !== 'ask_user' && name !== 'suggest_followups',
      ),
    )
  })

  test('brands Codebuff roots as Codebuff', () => {
    expect(base3.systemPrompt).toContain('/usage')
    expect(base3.systemPrompt).not.toContain('Freebuff')
  })
})
