import { describe, expect, test } from 'bun:test'
import { formatBashContext } from './bash-command'
import type { BashCommandResult } from './bash-command'

describe('formatBashContext (#9 bash mode)', () => {
  test('returns empty string for no results', () => {
    expect(formatBashContext([])).toBe('')
  })

  test('renders command, cwd, exit code and stdout', () => {
    const r: BashCommandResult = {
      ok: true,
      command: 'git log --oneline -1',
      cwd: '/repo',
      stdout: 'abc123 fix: bug\n',
      stderr: '',
      exitCode: 0
    }
    const out = formatBashContext([r])
    expect(out).toContain('<user_terminal_commands>')
    expect(out).toContain('The user ran the following terminal command(s) before this message:')
    expect(out).toContain('Command: git log --oneline -1')
    expect(out).toContain('Directory: /repo')
    expect(out).toContain('Exit code: 0')
    expect(out).toContain('Stdout:\nabc123 fix: bug\n')
    expect(out).toContain('</user_terminal_commands>')
  })

  test('includes stderr and error line for failing commands', () => {
    const r: BashCommandResult = {
      ok: false,
      command: 'npm test',
      cwd: '/repo',
      stdout: 'partial',
      stderr: '2 failed',
      exitCode: 1,
      errorMessage: 'Command timed out'
    }
    const out = formatBashContext([r])
    expect(out).toContain('Stderr:\n2 failed')
    expect(out).toContain('Error: Command timed out')
  })

  test('separates multiple commands with --- and marks truncation', () => {
    const results: BashCommandResult[] = [
      { ok: true, command: 'a', cwd: '/r', stdout: 'out-a', stderr: '', exitCode: 0 },
      { ok: true, command: 'b', cwd: '/r', stdout: 'x'.repeat(70_000), stderr: '', exitCode: 0, truncated: true }
    ]
    const out = formatBashContext(results)
    expect(out).toContain('---')
    expect(out).toContain('Command: a')
    expect(out).toContain('Command: b')
    expect(out).toContain('(Output truncated)')
  })
})
