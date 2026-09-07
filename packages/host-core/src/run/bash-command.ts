/**
 * #9 Bash mode (`!command`) — host-side shell execution for user-initiated
 * commands typed in the composer with a leading `!`.
 *
 * The output is returned to the renderer, which bakes it into the next prompt
 * inside a `<user_terminal_commands>` block (same contract as the upstream
 * CLI's bash context — the agent sees exactly what ran, where, and its exit
 * status, and can continue from it).
 *
 * Security posture (ADR-12 / ADR-12b):
 *  - runs through the SDK's runTerminalCommand, which scrubs provider API keys
 *    from the inherited process environment before spawning the shell;
 *  - SYNC only (no background processes to orphan);
 *  - wall-clock timeout capped well below the agent tool's own limits — this
 *    runs on the user's keystroke, so a hung command must not wedge the UI.
 */

import { runTerminalCommand } from '@codebuff/sdk'

/** Default / max wall-clock budget for a user-initiated `!command`. */
const BASH_DEFAULT_TIMEOUT_SECONDS = 30
const BASH_MAX_TIMEOUT_SECONDS = 600
/** Output kept per stream (stdout / stderr) before truncation. */
const BASH_MAX_OUTPUT_CHARS = 60_000

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
 * Run a user-initiated shell command. Never throws — every failure mode
 * (spawn error, timeout, non-zero exit) resolves to a structured result.
 */
export async function runBashCommand(params: {
  command: string
  cwd: string
  /** Wall-clock budget in seconds (default 30, clamped to ≤ 600). */
  timeoutSeconds?: number
}): Promise<BashCommandResult> {
  const command = typeof params.command === 'string' ? params.command.trim() : ''
  const cwd = typeof params.cwd === 'string' && params.cwd ? params.cwd : process.cwd()
  if (!command) {
    return { ok: false, command, cwd, stdout: '', stderr: '', exitCode: -1, errorMessage: 'Empty command' }
  }
  const requested = Number.isFinite(params.timeoutSeconds) ? Number(params.timeoutSeconds) : BASH_DEFAULT_TIMEOUT_SECONDS
  const timeoutSeconds = Math.min(Math.max(1, Math.floor(requested)), BASH_MAX_TIMEOUT_SECONDS)

  try {
    const output = await runTerminalCommand({
      command,
      process_type: 'SYNC',
      cwd,
      timeout_seconds: timeoutSeconds,
    })
    const first = output?.[0]
    const value = first && typeof first === 'object' && 'value' in first ? (first.value as Record<string, unknown>) : undefined
    if (!value) {
      return { ok: false, command, cwd, stdout: '', stderr: '', exitCode: -1, errorMessage: 'No output from shell' }
    }
    const errorMessage = typeof value.errorMessage === 'string' ? value.errorMessage : typeof value.message === 'string' ? value.message : undefined
    const timedOut = errorMessage ? /timed out|timeout/i.test(errorMessage) : false
    const rawStdout = typeof value.stdout === 'string' ? value.stdout : ''
    const rawStderr = typeof value.stderr === 'string' ? value.stderr : ''
    const truncated = rawStdout.length > BASH_MAX_OUTPUT_CHARS || rawStderr.length > BASH_MAX_OUTPUT_CHARS
    return {
      ok: !errorMessage,
      command,
      cwd,
      stdout: rawStdout.slice(0, BASH_MAX_OUTPUT_CHARS),
      stderr: rawStderr.slice(0, BASH_MAX_OUTPUT_CHARS),
      exitCode: typeof value.exitCode === 'number' ? value.exitCode : errorMessage ? 1 : 0,
      errorMessage,
      timedOut: timedOut || undefined,
      truncated: truncated || undefined,
    }
  } catch (err) {
    return {
      ok: false,
      command,
      cwd,
      stdout: '',
      stderr: '',
      exitCode: -1,
      errorMessage: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Bake one or more completed bash results into the `<user_terminal_commands>`
 * context block prepended to the next prompt (mirrors the upstream CLI's
 * formatBashContextForPrompt, so the model already knows this shape).
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
