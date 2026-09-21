import { afterEach, describe, expect, test } from 'bun:test'

import { extractTrialFailures } from '../src/renderer/src/utils/trial-counter'

/**
 * §4.6 direct-bind trial counter: the pattern layer that decides whether a
 * tool output chunk carries a trial-relevant failure. Deliberately biased
 * against false positives (a missed EPERM costs one data point; a false
 * positive poisons the Route-A-vs-stay-direct verdict).
 */
describe('extractTrialFailures (§4.6 trial counter)', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window
  })

  test('flags FUSE exec denials (Operation not permitted)', () => {
    expect(extractTrialFailures('sh: /workspace/p/node_modules/.bin/tsc: Permission denied\n')).toEqual([])
    expect(extractTrialFailures('spawnSync /bin/sh EACCES\n')).toEqual([])
    expect(
      extractTrialFailures('env: /workspace/p/node_modules/@esbuild/linux-arm64/bin/esbuild: Operation not permitted')
    ).toEqual(['exec'])
  })

  test('flags symlink failures in both wordings', () => {
    // npm's EPERM symlink wording also carries "operation not permitted" —
    // it counts in BOTH counters by design (it is an EPERM AND a symlink
    // failure; the plan tracks the two separately).
    expect(
      extractTrialFailures('npm warn install Error: EPERM: operation not permitted, symlink ../semver/bin/semver.js')
    ).toEqual(['exec', 'symlink'])
    expect(extractTrialFailures('ln -s target link\nln: failed to create symbolic link: Operation not permitted')).toEqual([
      // kinds return in pattern-array order — this line is BOTH an exec and a
      // symlink failure ("Operation not permitted" + "symbolic link: ...").
      'exec',
      'symlink'
    ])
  })

  test('flags read-only remounts', () => {
    expect(extractTrialFailures('touch: cannot touch ' + "'x'" + ': Read-only file system')).toEqual(['readonly'])
  })

  test('plain output stays silent (no false positives)', () => {
    expect(extractTrialFailures('added 52 packages in 3s\n\n12 files changed, 3 insertions(+)\n')).toEqual([])
    expect(extractTrialFailures('EPERM appears in this doc as an acronym mention only')).toEqual([])
  })

  test('dedupes to one hit per kind per chunk', () => {
    const out = extractTrialFailures('a\nOperation not permitted\nb\nOperation not permitted\n')
    expect(out).toEqual(['exec'])
  })

  test('empty input is a no-op', () => {
    expect(extractTrialFailures('')).toEqual([])
  })
})
