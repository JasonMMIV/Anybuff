/**
 * §4.6 direct-bind trial counter (renderer half).
 *
 * The trial verdict needs usage data over 2–4 weeks: how often direct-bound
 * projects hit FUSE semantics the engine cannot survive (EPERM exec from
 * `npm install` native builds, symlink failures on node_modules), and how
 * much the direct vs copy flows are actually used. The plan's minimal
 * implementation: pattern-match TOOL OUTPUT in the renderer (paths never
 * leave the device — this is a counter + short English label only) and log
 * through the existing native logEvent bridge into the on-device EngineLog.
 */

/** True when the app runs inside the Android WebView shell. */
export function isAndroidShell(): boolean {
  if (typeof window === 'undefined') return false
  const native = (window as unknown as { __ANYBUFF_NATIVE__?: unknown }).__ANYBUFF_NATIVE__
  return typeof native === 'object' && native !== null
}

/**
 * Output substrings that indicate a failure mode the direct-bind trial is
 * measuring. Only concrete, vendor-worded fragments — deliberate false-
 * negative bias (a missed EPERM costs one data point; a false positive
 * poisons the verdict). `EPERM` alone is too generic (reads on legit
 * permission denials) — the "Operation not permitted" phrase (what FUSE
 * returns for exec/symlink violations) is the actual fingerprint.
 */
const FAILURE_PATTERNS: Array<{ kind: string; regex: RegExp }> = [
  // FUSE exec denial — "npm install"/build tools launching native binaries.
  { kind: 'exec', regex: /Operation not permitted/i },
  // Symlink creation failure — node_modules installs are the classic case.
  // Wordings: npm puts EPERM BEFORE the word symlink ("EPERM: operation not
  // permitted, symlink .."); coreutils ln spells it out ("failed to create
  // symbolic link: ..."); node's fs reports the failing call ("function symlink").
  { kind: 'symlink', regex: /(EPERM[^\n]{0,80}symlink|symlink[^\n]{0,80}(not permitted|not implemented|EPERM)|symbolic link[^\n]{0,80}(not permitted|not implemented|EPERM)|function symlink)/i },
  // Read-only remount mid-session (rare; strong signal when it happens).
  { kind: 'readonly', regex: /Read-only file system/i },
]

/**
 * Extract trial failure signals from a chunk of tool output text.
 * Returns at most one entry per kind per call (repeated identical failures
 * within one output chunk carry no extra information for the verdict).
 */
export function extractTrialFailures(text: string): string[] {
  if (!text) return []
  const hits: string[] = []
  for (const { kind, regex } of FAILURE_PATTERNS) {
    if (regex.test(text)) hits.push(kind)
  }
  return hits
}

/** Sliding-window rate limit state (shared per module instance). */
const WINDOW_MS = 10 * 60 * 1000
const MAX_PER_KIND = 10
const recent: Record<string, number[]> = {}

/** Log a failure kind through the native bridge, rate-limited per kind. */
export function logTrialFailure(kind: string): void {
  if (typeof window === 'undefined') return
  const native = (window as unknown as { __ANYBUFF_NATIVE__?: { logEvent?: (kind: string, detail: string) => void } })
    .__ANYBUFF_NATIVE__
  const log = native?.logEvent
  if (!log) return
  const now = Date.now()
  const arr = (recent[kind] ??= []).filter((t) => now - t < WINDOW_MS)
  arr.push(now)
  recent[kind] = arr
  if (arr.length > MAX_PER_KIND) return
  log('trial', `direct-trial: ${kind} failure (${arr.length}/${MAX_PER_KIND} in 10m)`)
}

/** Convenience: extract + log in one call. Returns the kinds hit. */
export function recordToolOutputForTrial(text: string): string[] {
  const kinds = extractTrialFailures(text)
  for (const k of kinds) logTrialFailure(k)
  return kinds
}

/** Count pick outcomes (direct vs copy) — the usage-side of the verdict.
 *  Deduped within 10s: 'copying' progress fires repeatedly per chunk, and a
 *  pick cannot legitimately flip direct→copy that fast. */
let lastPick: { mode: string; at: number } | null = null
export function logPickOutcome(mode: 'direct' | 'copy'): void {
  if (typeof window === 'undefined') return
  const now = Date.now()
  if (lastPick && lastPick.mode === mode && now - lastPick.at < 10_000) return
  lastPick = { mode, at: now }
  const native = (window as unknown as { __ANYBUFF_NATIVE__?: { logEvent?: (kind: string, detail: string) => void } })
    .__ANYBUFF_NATIVE__
  native?.logEvent?.('trial', `pick outcome: ${mode}`)
}

/**
 * Copy of the `anybuff:folder-progress` detail contract used by the shell's
 * pushProgress (NativeBridge.kt). Kept as a type instead of importing from
 * the bridge (the shell writes JS, not TS).
 */
export interface FolderProgressDetail {
  phase?: string
  copied?: number
  error?: string
}
