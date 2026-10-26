import { describe, expect, test } from 'bun:test'

import {
  GIT_COMMIT_MESSAGES_MAX_CHARS,
  GIT_STATUS_MAX_CHARS,
  getGitChangesPrompt,
} from '../system-prompt/prompts'
import { getSearchSystemPrompt } from '../system-prompt/search-system-prompt'
import { mockFileContext } from './test-utils'

import type { ProjectFileContext } from '@codebuff/common/util/file'

type GitChanges = ProjectFileContext['gitChanges']

const withGitChanges = (gitChanges: GitChanges): ProjectFileContext => ({
  ...mockFileContext,
  gitChanges,
})

// truncateString appends an ellipsis when it truncates.
const ELLIPSIS_CHARS = 3
const MAX_PROMPT_CHARS =
  GIT_STATUS_MAX_CHARS + GIT_COMMIT_MESSAGES_MAX_CHARS + 2 * ELLIPSIS_CHARS + 500

const createMockLogger = () => ({
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => createMockLogger(),
})

const dirtyGitChanges: GitChanges = {
  status: [
    'On branch master',
    'Changes not staged for commit:',
    '\tmodified:   src/a.ts',
    'Untracked files:',
    '\tsrc/new-file.ts',
  ].join('\n'),
  diff: 'diff --git a/src/a.ts b/src/a.ts\n-old line\n+new line',
  diffCached: 'diff --git a/src/b.ts b/src/b.ts\n-old cached\n+new cached',
  lastCommitMessages: 'feat: add a\nfix: b',
}

describe('getGitChangesPrompt', () => {
  test('injects the working-tree status and the recent commit subjects', () => {
    const prompt = getGitChangesPrompt(withGitChanges(dirtyGitChanges))

    expect(prompt).toContain('<git_status>')
    expect(prompt).toContain('modified:   src/a.ts')
    expect(prompt).toContain('src/new-file.ts')
    expect(prompt).toContain('<git_commit_messages_most_recent_first>')
    expect(prompt).toContain('feat: add a')
  })

  test('does not inline diffs', () => {
    const prompt = getGitChangesPrompt(withGitChanges(dirtyGitChanges))

    expect(prompt).not.toContain('<git_diff>')
    expect(prompt).not.toContain('<git_diff_cached>')
    expect(prompt).not.toContain(dirtyGitChanges.diff)
    expect(prompt).not.toContain(dirtyGitChanges.diffCached)
  })

  test('stays descriptive instead of naming a tool (find_files shares this prompt)', () => {
    const prompt = getGitChangesPrompt(withGitChanges(dirtyGitChanges))

    expect(prompt).toContain('Diffs are not inlined here')
    expect(prompt).not.toContain('run_terminal_command')
    expect(prompt).not.toContain('basher')
  })

  test('worst case stays within budget', () => {
    const prompt = getGitChangesPrompt(
      withGitChanges({
        status: 's'.repeat(50_000),
        diff: 'd'.repeat(50_000),
        diffCached: 'c'.repeat(50_000),
        lastCommitMessages: 'm'.repeat(50_000),
      }),
    )

    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS)

    const status = prompt.split('<git_status>\n')[1].split('\n</git_status>')[0]
    const commits = prompt
      .split('<git_commit_messages_most_recent_first>\n')[1]
      .split('\n</git_commit_messages_most_recent_first>')[0]
    expect(status.length).toBe(GIT_STATUS_MAX_CHARS + ELLIPSIS_CHARS)
    expect(commits.length).toBe(GIT_COMMIT_MESSAGES_MAX_CHARS + ELLIPSIS_CHARS)
  })

  test('handles empty git changes without throwing', () => {
    const prompt = getGitChangesPrompt(
      withGitChanges({
        status: '',
        diff: '',
        diffCached: '',
        lastCommitMessages: '',
      }),
    )

    expect(prompt).toContain('<git_status>')
    expect(prompt).toContain('<git_commit_messages_most_recent_first>')
    expect(prompt).not.toContain('undefined')
  })

  test('returns an empty string when git changes are unavailable', () => {
    const fileContext = {
      ...mockFileContext,
      gitChanges: undefined,
    } as unknown as ProjectFileContext

    expect(getGitChangesPrompt(fileContext)).toBe('')
  })

  // getSearchSystemPrompt is the second consumer: it feeds the same snapshot to
  // find_files and derives the file-tree token budget from it.
  test('find_files search prompt uses the trimmed snapshot', () => {
    const prompt = getSearchSystemPrompt({
      fileContext: withGitChanges(dirtyGitChanges),
      messagesTokens: 1_000,
      logger: createMockLogger() as any,
      options: {
        agentStepId: 'step',
        clientSessionId: 'client',
        fingerprintId: 'fingerprint',
        userInputId: 'input',
        userId: undefined,
      },
    })

    expect(prompt).toContain('<git_status>')
    expect(prompt).toContain('src/new-file.ts')
    expect(prompt).not.toContain('<git_diff>')
    expect(prompt).not.toContain('<git_diff_cached>')
  })
})
