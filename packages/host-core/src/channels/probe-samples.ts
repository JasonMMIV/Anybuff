/**
 * ADR-27 / MC-2.2 — probe-sample persistence.
 *
 * The MC-2.1 probe shows endpoint verdicts in the UI; without this store
 * those raw 400 bodies evaporate when the panel closes. MC-2.3 (the
 * "must be one of ..." parser) needs real vendor 400 samples as its corpus —
 * this module is the collection mechanism: every probe that yields a
 * `rejected` / `replay-conflict` verdict persists the full body (capped) so
 * future probes keep feeding the corpus automatically.
 *
 * What is retained (deliberately narrow):
 *  - Only verdicts classified as rung rejections (400/422). Transport/auth
 *    failures (`error` verdicts) carry no vendor wording — they are noise
 *    for a parser corpus and can embed local network error text.
 *  - Full body up to 4096 chars (the UI excerpt is 400; a parser needs more
 *    of the vendor's wording around "must be one of ...").
 *  - Dedup by (providerId, model, rung, verdict, body): re-probing the same
 *    endpoint must not grow the file one identical entry at a time.
 *  - Bounded FIFO at 200 entries: an unbounded local corpus is a footgun.
 *
 * Writes are atomic (writeFileAtomic — ADR-13: unique temp + fsync +
 * rename-replace, never pre-delete, old file preserved on failure). Failures
 * NEVER break the probe itself: retention is best-effort by design (§2.3 —
 * the probe's job is verdicts, not bookkeeping).
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { hostPaths } from '../env'
import { writeFileAtomic } from '../files/atomic-write'

export interface ProbeSample {
  /** `${providerId}/${model}` — the row key the UI groups by. */
  key: string
  providerId: string
  model: string
  /** The rung that was probed. */
  rung: string
  /** 'rejected' | 'replay-conflict' — never accepted/not-probed/error. */
  verdict: 'rejected' | 'replay-conflict'
  /** HTTP status of the failing round (400/422). */
  status: number
  /** Raw vendor body (capped). The MC-2.3 parser's raw material. */
  body: string
  /** ISO timestamp of the probe round. */
  at: string
}

const SAMPLES_FILE = 'probe-samples.json'
const MAX_SAMPLES = 200
const MAX_BODY_CHARS = 4096

function samplesPath(): string {
  return join(hostPaths().dataDir, SAMPLES_FILE)
}

function capBody(body: string): string {
  return body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) : body
}

function sameEvidence(
  a: ProbeSample,
  key: string,
  rung: string,
  verdict: ProbeSample['verdict'],
  body: string,
): boolean {
  return a.key === key && a.rung === rung && a.verdict === verdict && a.body === body
}

/** Read the retained corpus; corrupt/missing file → empty (self-healing read). */
export function listProbeSamples(): ProbeSample[] {
  try {
    const file = samplesPath()
    if (!existsSync(file)) return []
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (s): s is ProbeSample =>
        typeof s === 'object' &&
        s !== null &&
        typeof (s as ProbeSample).key === 'string' &&
        typeof (s as ProbeSample).rung === 'string' &&
        ((s as ProbeSample).verdict === 'rejected' ||
          (s as ProbeSample).verdict === 'replay-conflict') &&
        typeof (s as ProbeSample).body === 'string',
    )
  } catch {
    return []
  }
}

/**
 * Persist the rejection evidence from one probe. Returns the number of NEW
 * samples retained (0 when everything deduped) so the channel can surface
 * "retained N sample(s) for the 400 corpus" in the UI.
 */
export function retainProbeSamples(
  providerId: string,
  model: string,
  rungs: Array<{
    rung: string
    verdict: ProbeSample['verdict']
    status?: number
    body?: string
  }>,
): number {
  const eligible = rungs.filter(
    (r) =>
      (r.verdict === 'rejected' || r.verdict === 'replay-conflict') &&
      typeof r.status === 'number' &&
      typeof r.body === 'string' &&
      r.body.length > 0,
  )
  if (eligible.length === 0) return 0

  const key = `${providerId}/${model}`
  const existing = listProbeSamples()
  let retained = 0
  const at = new Date().toISOString()
  for (const r of eligible) {
    const body = capBody(r.body!)
    const dup = existing.some((s) => sameEvidence(s, key, r.rung, r.verdict, body))
    if (dup) continue
    existing.push({
      key,
      providerId,
      model,
      rung: r.rung,
      verdict: r.verdict,
      status: r.status!,
      body,
      at,
    })
    retained += 1
  }
  if (retained === 0) return 0

  // FIFO trim: keep the most recent MAX_SAMPLES entries.
  const trimmed = existing.length > MAX_SAMPLES ? existing.slice(-MAX_SAMPLES) : existing
  try {
    writeFileAtomic(samplesPath(), JSON.stringify(trimmed, null, 2))
  } catch {
    // Best-effort retention: the probe's verdicts already reached the UI.
    return 0
  }
  return retained
}

/** Wipe the corpus (UI "Clear samples"). */
export function clearProbeSamples(): boolean {
  try {
    writeFileAtomic(samplesPath(), JSON.stringify([]))
    return true
  } catch {
    return false
  }
}
