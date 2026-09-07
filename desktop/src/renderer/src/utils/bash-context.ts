/**
 * #9 Bash mode (`!command`) — renderer-side formatting helpers.
 *
 * The EXECUTION lives in @codebuff/host-core (run/bash-command.ts, ADR-12b
 * scrubbed env); this module only shapes the captured results into the
 * `<user_terminal_commands>` context block that is prepended to the next
 * prompt — the same wire format the upstream CLI's bash context uses, so the
 * model already knows how to read it.
 */

export interface BashCommandResult {
  ok: boolean
  command: string
  cwd: string
  stdout: string
  stderr: string
  exitCode: number
  errorMessage?: string
  timedOut?: boolean
  truncated?: boolean
}

/**
 * Bake completed bash results into the `<user_terminal_commands>` context
 * block prepended to the next prompt (mirrors host-core's formatBashContext —
 * keep the two in sync).
 */
export function formatBashContext(results: BashCommandResult[]): string {
  const completed = results.filter((r) => r && r.command)
  if (completed.length === 0) return ''
  const context = completed
    .map((r) => {
      let block = `Command: ${r.command}\nDirectory: ${r.cwd}\nExit code: ${r.exitCode}`
      if (r.stdout) block += `\nStdout:\n${r.stdout}`
      if (r.stderr) block += `\nStderr:\n${r.stderr}`
      if (r.errorMessage && r.exitCode !== 0) block += `\nError: ${r.errorMessage}`
      if (r.truncated) block += '\n(Output truncated)'
      return block
    })
    .join('\n\n---\n\n')
  return `<user_terminal_commands>\nThe user ran the following terminal command(s) before this message:\n\n${context}\n</user_terminal_commands>\n\n`
}
