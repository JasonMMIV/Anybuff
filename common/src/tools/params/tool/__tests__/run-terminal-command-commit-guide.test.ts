import { describe, expect, it } from 'bun:test'

import {
  gitCommitGuidePrompt,
  runTerminalCommandParams,
} from '../run-terminal-command'

describe('gitCommitGuidePrompt', () => {
  it('does not ask the model to add a Codebuff attribution footer', () => {
    // Upstream appended "Generated with Codebuff" + a Co-Authored-By trailer
    // to every commit. AnyBuff is a local BYOK client, so commits belong to
    // the user, not to the upstream brand.
    for (const text of [
      gitCommitGuidePrompt,
      runTerminalCommandParams.description,
    ]) {
      expect(text).not.toContain('Co-Authored-By')
      expect(text).not.toContain('noreply@codebuff.com')
      expect(text).not.toContain('Codebuff')
    }
  })

  it('still documents the HEREDOC commit syntax', () => {
    expect(gitCommitGuidePrompt).toContain("cat <<'EOF'")
    expect(gitCommitGuidePrompt).toContain('git commit -m')
  })
})
