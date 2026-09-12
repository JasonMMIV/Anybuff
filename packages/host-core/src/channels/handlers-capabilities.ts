/**
 * ADR-27 channel handlers: model capabilities — listing & maintenance
 * (MC-1.1/1.3/1.4) + interactive reasoning-effort probe (MC-2.1).
 *
 * - listModelCapabilities: the full per-provider/per-model listing with
 *   provenance badges (verified/declared/unknown) for the Settings UI.
 * - saveModelCapability: one validated single-entry upsert (field-by-field
 *   merge, never a wholesale provider overwrite).
 * - importModelCapabilities: LLM-produced JSON fragment, applied line by
 *   line — a bad line reports independently and never blocks the rest
 *   (§2.4). Only the modelCapabilities subtree is writable (§2.2).
 *
 * MC-2.1 probe (below) — the user asks, the endpoint answers. For each
 * candidate rung it sends a MINIMAL two-round conversation and reports the
 * raw verdicts:
 *
 *  Round 1 — acceptance: does the endpoint accept `reasoning_effort: <rung>`
 *   on a plain (no-tools) request? A 400 here means the rung is not a legal
 *   wire value for this model.
 *  Round 2 — replay contract (only for rungs that passed round 1, and only
 *   on models that reason): DeepSeek-style thinking modes require
 *   reasoning_content on every assistant message of any later request that
 *   carries tools ("even for turns where the model did not perform a tool
 *   call" — ADR-26). A single-round probe CANNOT see this: the 400 only
 *   appears when history from round 1 is replayed with a tools-bearing
 *   request. So the probe replays round 1's assistant message in a
 *   tools-bearing round 2 and classifies the outcome.
 *
 * The probe never writes anything back by itself (§2.3: probe, never silent
 * self-heal) — the user reviews the per-rung verdicts and confirms.
 */

import {
  buildReasoningLadderInfos,
  getAppSettings,
  getProviderApiKey,
  importModelCapabilities,
  loadSettings,
  saveModelCapability,
  type ModelCapabilityUpsert,
  type ReasoningLadderInfo,
} from '../settings/settings'
import { clearProbeSamples, listProbeSamples, retainProbeSamples } from './probe-samples'

/** AnyBuff:listModelCapabilities — per provider, per model rows. */
export function listModelCapabilities(): unknown {
  const settings = getAppSettings()
  const infos = buildReasoningLadderInfos(settings.providers)
  const rows: Array<{
    providerId: string
    model: string
    key: string
    efforts: string[]
    source: ReasoningLadderInfo['source']
    verifiedAt?: string
    verifiedBy?: string
    declared?: ReasoningLadderInfo['declared']
    overriddenSeed?: ReasoningLadderInfo['overriddenSeed']
    context?: ReasoningLadderInfo['context']
    defaultEffort?: string
  }> = []
  for (const provider of settings.providers) {
    for (const model of provider.models ?? []) {
      const key = `${provider.id}/${model}`
      const info = infos[key]
      if (!info) {
        rows.push({ providerId: provider.id, model, key, efforts: [], source: 'unknown' })
        continue
      }
      rows.push({
        providerId: provider.id,
        model,
        key,
        efforts: info.efforts,
        source: info.source,
        ...(info.verifiedAt !== undefined ? { verifiedAt: info.verifiedAt } : {}),
        ...(info.verifiedBy !== undefined ? { verifiedBy: info.verifiedBy } : {}),
        ...(info.declared !== undefined ? { declared: info.declared } : {}),
        ...(info.overriddenSeed !== undefined ? { overriddenSeed: info.overriddenSeed } : {}),
        ...(info.context !== undefined ? { context: info.context } : {}),
        ...(info.defaultEffort !== undefined ? { defaultEffort: info.defaultEffort } : {}),
      })
    }
  }
  return { ok: true, rows, providers: settings.providers.map((p) => ({ id: p.id, label: p.label })) }
}

/** AnyBuff:saveModelCapability — one validated upsert. */
export function saveModelCapabilityChannel(payload: unknown): unknown {
  try {
    const saved = saveModelCapability(payload as ModelCapabilityUpsert)
    if (!saved) return { ok: false, error: 'provider not found' }
    return { ok: true, rows: listModelCapabilitiesInternal() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** AnyBuff:importModelCapabilities — fragment applied line by line. */
export function importModelCapabilitiesChannel(payload: unknown): unknown {
  const result = importModelCapabilities(payload as Parameters<typeof importModelCapabilities>[0])
  return { ...result, rows: result.ok || result.lines.length ? listModelCapabilitiesInternal() : undefined }
}

function listModelCapabilitiesInternal(): unknown {
  const listed = listModelCapabilities() as { rows: unknown[] }
  return listed.rows
}

/* ─── MC-2.1: interactive reasoning-effort probe ───────────────────────── */

/** Probe verdict for one candidate rung. */
export type ProbeVerdict =
  | 'accepted' // round 1 + round 2 both clean
  | 'rejected' // round 1 (or round 2 with a non-replay) 400 — not a legal rung here
  | 'replay-conflict' // round 1 clean, round 2 400 — history-replay contract violation (ADR-26 class)
  | 'not-probed' // round 1 passed but the model gave no reasoning, so round 2's contract could not be exercised
  | 'error' // transport/auth failure — probe inconclusive, never a 400

export interface ProbeRungResult {
  rung: string
  verdict: ProbeVerdict
  /** HTTP status of the failing round, when any. */
  status?: number
  /** First ~400 chars of the raw error body, when any — the evidence. */
  bodyExcerpt?: string
  /** Whether round 1's reply carried reasoning content. */
  sawReasoning?: boolean
}

const PROBE_TIMEOUT_MS = 20000
const BODY_EXCERPT_CHARS = 400
const MAX_PROBE_RUNGS = 8
/** Statuses that mean "the endpoint evaluated and rejected the request"
 * (verdict: rejected). Anything else — 401/403 (auth), 429 (rate limit),
 * 5xx (upstream) — is inconclusive and must never masquerade as a rung
 * verdict (review round 1: an expired key read as "rung not legal"). */
const RUNG_REJECTION_STATUSES = new Set([400, 422])

function excerpt(body: string): string {
  const trimmed = body.trim()
  return trimmed.length > BODY_EXCERPT_CHARS
    ? `${trimmed.slice(0, BODY_EXCERPT_CHARS)}…`
    : trimmed
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  reasoning_content?: string
}

/** DeepSeek-family thinking modes refuse replayed tool-call history whose
 * assistant messages lack reasoning_content (ADR-26) — the marker strings
 * in their 400 body identify that class of failure. */
const REPLAY_400_MARKERS = [
  'reasoning_content',
  'reasoning content',
  'must be passed back',
]

function isReplayContract400(status: number, body: string): boolean {
  if (status !== 400) return false
  const lower = body.toLowerCase()
  return REPLAY_400_MARKERS.some((m) => lower.includes(m))
}

async function postChatCompletion(opts: {
  url: string
  apiKey: string | undefined
  body: Record<string, unknown>
}): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await fetch(opts.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
    },
    body: JSON.stringify(opts.body),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  })
  const text = await res.text()
  return { ok: res.ok, status: res.status, body: text }
}

/** Extract reasoning_content / reasoning from a chat-completions reply. */
function extractReply(
  raw: string,
): { assistantText: string; reasoning: string | undefined } {
  try {
    const parsed = JSON.parse(raw) as {
      choices?: Array<{
        message?: {
          content?: string
          reasoning_content?: string
          reasoning?: string
        }
      }>
    }
    const message = parsed.choices?.[0]?.message ?? {}
    return {
      assistantText: typeof message.content === 'string' ? message.content : '',
      reasoning:
        typeof message.reasoning_content === 'string'
          ? message.reasoning_content
          : typeof message.reasoning === 'string'
            ? message.reasoning
            : undefined,
    }
  } catch {
    return { assistantText: '', reasoning: undefined }
  }
}

/** AnyBuff:listProbeSamples — the retained 400 corpus (MC-2.2). */
export function listProbeSamplesChannel(): unknown {
  return { ok: true, samples: listProbeSamples() }
}

/** AnyBuff:clearProbeSamples — wipe the corpus (user-invoked). */
export function clearProbeSamplesChannel(): unknown {
  const ok = clearProbeSamples()
  return ok ? { ok: true } : { ok: false, error: 'failed to clear probe samples' }
}

/**
 * AnyBuff:probeReasoningEffort — probe candidate rungs on one model.
 * The UI passes the candidate list (user-typed rungs included; 'default' is
 * stripped — it is a menu sentinel, not a wire value).
 */
export async function probeReasoningEffortChannel(payload: {
  providerId: string
  model: string
  rungs?: string[]
}): Promise<unknown> {
  try {
    const { providerId, model } = payload
    const rungs = (payload.rungs ?? [])
      .filter((r): r is string => typeof r === 'string' && r.length > 0 && r !== 'default')
      .slice(0, MAX_PROBE_RUNGS)
    if (!providerId || typeof providerId !== 'string') return { ok: false, error: 'missing providerId' }
    if (!model || typeof model !== 'string') return { ok: false, error: 'missing model' }
    if (rungs.length === 0) return { ok: false, error: 'no candidate rungs to probe' }

    const s = loadSettings()
    const provider = s.providers.find((p) => p.id === providerId)
    if (!provider) return { ok: false, error: 'provider not found' }
    if (provider.type === 'anthropic-compatible') {
      return {
        ok: false,
        error:
          'Probing is implemented for OpenAI-compatible endpoints only. Anthropic-compatible reasoning uses thinking.budget_tokens, not reasoning_effort rungs.',
      }
    }
    const apiKey = getProviderApiKey(providerId)
    if (!apiKey && !/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(provider.baseURL)) {
      return { ok: false, error: 'no API key stored for this provider — save one in Providers first' }
    }
    const url = `${provider.baseURL.replace(/\/+$/, '')}/chat/completions`

    const results: ProbeRungResult[] = []
    // MC-2.2: the full-bodies backing the UI's 400-char excerpts are kept
    // for the MC-2.3 parser corpus — retention is best-effort and never
    // fails the probe itself (see probe-samples.ts).
    const sampleInputs: Array<{
      rung: string
      verdict: 'rejected' | 'replay-conflict'
      status: number
      body: string
    }> = []
    for (const rung of rungs) {
      // Round 1 — plain acceptance (no tools: per the vendor's docs the
      // reasoning_content replay contract does not bind tool-less requests).
      let round1: { ok: boolean; status: number; body: string }
      try {
        round1 = await postChatCompletion({
          url,
          apiKey,
          body: {
            model,
            messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
            reasoning_effort: rung,
            max_tokens: 16,
            stream: false,
          },
        })
      } catch (e) {
        results.push({
          rung,
          verdict: 'error',
          bodyExcerpt: e instanceof Error ? e.message : String(e),
        })
        continue
      }
      if (!round1.ok) {
        const verdict = RUNG_REJECTION_STATUSES.has(round1.status) ? 'rejected' : 'error'
        if (verdict === 'rejected') {
          sampleInputs.push({ rung, verdict, status: round1.status, body: round1.body })
        }
        results.push({
          rung,
          verdict,
          status: round1.status,
          bodyExcerpt: excerpt(round1.body),
        })
        continue
      }
      const reply = extractReply(round1.body)

      // Round 2 — replay contract (ADR-26): replay round 1's assistant turn
      // in a tools-bearing request. Round 1 was clean, so a 400 here is
      // evidence the endpoint enforces a history-replay contract our wire
      // layer must satisfy (the ADR-26 backfill is exactly this defense).
      let round2: { ok: boolean; status: number; body: string }
      try {
        const assistantReplay: ChatMessage = {
          role: 'assistant',
          content: reply.assistantText || 'ok',
        }
        if (reply.reasoning) {
          // Include the reasoning the endpoint produced — vendors that
          // REQUIRE it on replay accept this shape; omitting it would test
          // our backfill, not the endpoint's contract.
          assistantReplay.reasoning_content = reply.reasoning
        }
        round2 = await postChatCompletion({
          url,
          apiKey,
          body: {
            model,
            messages: [
              { role: 'user', content: 'Reply with the single word: ok' },
              assistantReplay,
              { role: 'user', content: 'Call the provided tool exactly once.' },
            ],
            reasoning_effort: rung,
            // Round 2 only needs to trigger request validation — but a
            // tool-call reply's JSON can easily exceed 16 tokens, and strict
            // endpoints 400 on mid-tool-call truncation (false "rejected").
            max_tokens: 128,
            stream: false,
            tools: [
              {
                type: 'function',
                function: {
                  name: 'probe_echo',
                  description: 'Echo the input.',
                  parameters: {
                    type: 'object',
                    properties: { text: { type: 'string' } },
                    required: ['text'],
                  },
                },
              },
            ],
            tool_choice: 'auto',
          },
        })
      } catch (e) {
        results.push({
          rung,
          verdict: 'error',
          bodyExcerpt: e instanceof Error ? e.message : String(e),
        })
        continue
      }
      if (!round2.ok) {
        const verdict = RUNG_REJECTION_STATUSES.has(round2.status)
          ? isReplayContract400(round2.status, round2.body)
            ? 'replay-conflict'
            : 'rejected'
          : 'error'
        if (verdict === 'rejected' || verdict === 'replay-conflict') {
          sampleInputs.push({ rung, verdict, status: round2.status, body: round2.body })
        }
        results.push({
          rung,
          verdict,
          status: round2.status,
          bodyExcerpt: excerpt(round2.body),
          sawReasoning: reply.reasoning !== undefined,
        })
        continue
      }
      results.push({
        rung,
        verdict: reply.reasoning !== undefined ? 'accepted' : 'not-probed',
        sawReasoning: reply.reasoning !== undefined,
      })
    }

    // MC-2.2: retainProbeSamples is best-effort by design (it swallows its
    // own read/write errors and returns 0) — retention never fails the probe.
    const retainedCount = retainProbeSamples(providerId, model, sampleInputs)

    return {
      ok: true,
      model,
      results,
      /** The rungs the evidence supports declaring (accepted only —
       * replay-conflict and not-probed are surfaced, never auto-applied). */
      acceptedRungs: results.filter((r) => r.verdict === 'accepted').map((r) => r.rung),
      /** MC-2.2: how many NEW 400 samples were retained for the corpus
       * (deduped; 0 when nothing new or retention failed — never fatal). */
      retainedCount,
      note: 'Two-round probe: acceptance without tools, then history replay with tools. "not-probed" = the model produced no reasoning content, so the replay contract could not be exercised.',
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
