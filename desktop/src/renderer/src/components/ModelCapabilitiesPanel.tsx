import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  CheckCircleIcon,
  DownloadIcon,
  EditIcon,
  GaugeIcon,
  LightbulbIcon,
  RefreshIcon,
  TrashIcon,
  XIcon
} from './Icons'
import CustomSelect from './CustomSelect'

/**
 * ADR-27 — Model Capabilities tab (MC-1.1/1.2/1.4).
 *
 * Every provider model gets a row: its effective reasoning ladder, a source
 * badge (已查證 verified seed / 自訂 declared / 未識別 unknown — §2.5), and
 * context overrides. Rows expand into an editor; literals pass VERBATIM —
 * `xhigh` and `extra-high` are different wire strings and no layer here
 * rewrites them (§2.1). Unknown rungs warn but never block (§2.4). The
 * Import box applies LLM-produced JSON line by line — a bad line reports
 * without blocking the rest.
 */

export interface CapabilityRow {
  providerId: string
  model: string
  key: string
  efforts: string[]
  source: 'verified' | 'declared' | 'unknown'
  verifiedAt?: string
  verifiedBy?: string
  declared?: {
    efforts?: string[]
    defaultEffort?: string
    supported?: boolean
    params?: Record<string, string | number | boolean>
  }
  overriddenSeed?: { efforts: string[]; verifiedAt: string }
  context?: { windowTokens?: number; outputTokens?: number }
  defaultEffort?: string
}

interface ProviderMeta {
  id: string
  label: string
}

const COMMON_RUNGS = ['low', 'medium', 'high', 'xhigh', 'extra-high', 'max', 'minimal', 'none']

function sourceBadge(row: CapabilityRow): { label: string; className: string; title: string } {
  if (row.source === 'verified') {
    return {
      label: 'Verified',
      className: 'cap-badge cap-badge-verified',
      title: `Verified ${row.verifiedAt ?? ''} — ${row.verifiedBy ?? 'vendor docs'}`
    }
  }
  if (row.source === 'declared') {
    return {
      label: 'Custom',
      className: 'cap-badge cap-badge-declared',
      title: 'Your declaration wins for this route'
    }
  }
  return {
    label: 'Unrecognized',
    className: 'cap-badge cap-badge-unknown',
    title:
      'No known ladder for this model — the menu shows a conservative fallback. Declare rungs verified against your endpoint.'
  }
}

interface ProbeRungResult {
  rung: string
  verdict: 'accepted' | 'rejected' | 'replay-conflict' | 'not-probed' | 'error'
  status?: number
  bodyExcerpt?: string
  sawReasoning?: boolean
}

interface ProbeState {
  key: string
  model: string
  providerId: string
  running: boolean
  results: ProbeRungResult[] | null
  acceptedRungs: string[] | null
  note?: string
  error?: string
  /** MC-2.2: how many NEW 400 samples were retained for the corpus. */
  retainedCount?: number
}

/** MC-2.2: a retained 400 sample (probe-samples.ts shape). */
interface ProbeSampleRow {
  key: string
  providerId: string
  model: string
  rung: string
  verdict: 'rejected' | 'replay-conflict'
  status: number
  body: string
  at: string
}

export default function ModelCapabilitiesPanel() {
  const [rows, setRows] = useState<CapabilityRow[]>([])
  const [providers, setProviders] = useState<ProviderMeta[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [promptCopied, setPromptCopied] = useState(false)
  const [importText, setImportText] = useState('')
  const [importResult, setImportResult] = useState<
    { ok: boolean; lines: Array<{ model: string; ok: boolean; error?: string }> } | null
  >(null)
  const [probe, setProbe] = useState<ProbeState | null>(null)
  const [samples, setSamples] = useState<ProbeSampleRow[] | null>(null)
  const [samplesOpen, setSamplesOpen] = useState(false)
  const [samplesCopied, setSamplesCopied] = useState(false)

  const refreshSamples = useCallback(async () => {
    try {
      const result = (await window.AnyBuff.listProbeSamples()) as {
        ok: boolean
        samples?: ProbeSampleRow[]
      }
      setSamples(result.samples ?? [])
    } catch {
      setSamples([])
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const result = (await window.AnyBuff.listModelCapabilities()) as {
        ok: boolean
        rows?: CapabilityRow[]
        providers?: ProviderMeta[]
        error?: string
      }
      if (!result.ok) {
        setError(result.error ?? 'Failed to load capabilities')
        return
      }
      setRows(result.rows ?? [])
      setProviders(result.providers ?? [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void refresh()
    void refreshSamples()
  }, [refresh, refreshSamples])

  const [saving, setSaving] = useState(false)

  const saveRow = useCallback(
    async (payload: {
      providerId: string
      model: string
      clear?: boolean
      reasoning?: {
        supported?: boolean
        efforts?: string[]
        defaultEffort?: string
        params?: Record<string, string | number | boolean>
      }
      context?: { windowTokens?: number; outputTokens?: number }
    }) => {
      setSaving(true)
      try {
        const result = (await window.AnyBuff.saveModelCapability(payload)) as {
          ok: boolean
          error?: string
        }
        if (!result.ok) {
          setError(result.error ?? 'Save failed')
          return false
        }
        setError(null)
        await refresh()
        return true
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        return false
      } finally {
        setSaving(false)
      }
    },
    [refresh]
  )

  /** MC-2.1: probe candidate rungs — the endpoint's real answers, two
   * rounds per rung (acceptance, then tools-bearing history replay). */
  const runProbe = useCallback(
    async (row: CapabilityRow, rungs: string[]) => {
      setProbe({
        key: row.key,
        model: row.model,
        providerId: row.providerId,
        running: true,
        results: null,
        acceptedRungs: null,
      })
      try {
        const result = (await window.AnyBuff.probeReasoningEffort({
          providerId: row.providerId,
          model: row.model,
          rungs,
        })) as {
          ok: boolean
          results?: ProbeRungResult[]
          acceptedRungs?: string[]
          note?: string
          retainedCount?: number
          error?: string
        }
        if (!result.ok) {
          setProbe({
            key: row.key,
            model: row.model,
            providerId: row.providerId,
            running: false,
            results: null,
            acceptedRungs: null,
            error: result.error ?? 'probe failed',
          })
          return
        }
        setProbe({
          key: row.key,
          model: row.model,
          providerId: row.providerId,
          running: false,
          results: result.results ?? [],
          acceptedRungs: result.acceptedRungs ?? [],
          note: result.note,
          retainedCount: result.retainedCount,
        })
        // MC-2.2: rejections were persisted — refresh the corpus counter.
        if ((result.retainedCount ?? 0) > 0) await refreshSamples()
      } catch (e) {
        setProbe({
          key: row.key,
          model: row.model,
          providerId: row.providerId,
          running: false,
          results: null,
          acceptedRungs: null,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    },
    [refreshSamples]
  )

  const applyProbeAccepted = useCallback(
    async (p: NonNullable<ProbeState>) => {
      if (!p.acceptedRungs?.length) return
      const ok = await saveRow({
        providerId: p.providerId,
        model: p.model,
        reasoning: { efforts: [...p.acceptedRungs] },
      })
      if (ok) setProbe(null)
    },
    [saveRow]
  )

  const runImport = useCallback(async () => {
    setImportResult(null)
    let parsed: unknown
    try {
      parsed = JSON.parse(importText)
    } catch (e) {
      setImportResult({
        ok: false,
        lines: [{ model: '<parse>', ok: false, error: e instanceof Error ? e.message : String(e) }]
      })
      return
    }
    try {
      const result = (await window.AnyBuff.importModelCapabilities(parsed)) as {
        ok: boolean
        lines?: Array<{ model: string; ok: boolean; error?: string }>
        error?: string
      }
      setImportResult({ ok: result.ok, lines: result.lines ?? [] })
      if (result.ok || (result.lines?.length ?? 0) > 0) await refresh()
      if (result.error) setError(result.error)
    } catch (e) {
      setImportResult({ ok: false, lines: [{ model: '<channel>', ok: false, error: e instanceof Error ? e.message : String(e) }] })
    }
  }, [importText, refresh])

  const grouped = useMemo(() => {
    const byProvider = new Map<string, CapabilityRow[]>()
    const q = filter.trim().toLowerCase()
    for (const row of rows) {
      if (q && !row.model.toLowerCase().includes(q) && !row.providerId.toLowerCase().includes(q)) {
        continue
      }
      const list = byProvider.get(row.providerId) ?? []
      list.push(row)
      byProvider.set(row.providerId, list)
    }
    return byProvider
  }, [rows, filter])

  if (!loaded) {
    return (
      <div className="settings-tab-content">
        <p className="hint">Loading model capabilities…</p>
      </div>
    )
  }

  return (
    <div className="settings-tab-content">
      <div className="settings-section-head">
        <span>Model Capabilities</span>
        <div className="settings-section-actions">
          <input
            className="cap-filter-input"
            placeholder="Filter models…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button type="button" className="btn ghost small" onClick={() => void refresh()}>
            <RefreshIcon size={13} /> Refresh
          </button>
          <button type="button" className="btn ghost small" onClick={() => setImportOpen((v) => !v)}>
            <DownloadIcon size={13} /> Import JSON
          </button>
          <button
            type="button"
            className="btn ghost small"
            title="Retained 400 bodies from probes — the raw corpus for future auto-healing (MC-2.2)"
            onClick={() => setSamplesOpen((v) => !v)}
          >
            <LightbulbIcon size={13} /> Samples{samples ? ` (${samples.length})` : ''}
          </button>
        </div>
      </div>
      <p className="hint">
        Reasoning ladders and context windows per model. <strong>Verified</strong> = vendor-documented seed
        (hover for source + date); <strong>Custom</strong> = your declaration (wins for that route);{' '}
        <strong>Unrecognized</strong> = conservative menu fallback — declare rungs your endpoint actually
        accepts. Values are sent <em>verbatim</em>: <code>xhigh</code> and <code>extra-high</code> are
        different wire strings.
      </p>

      {error && (
        <div className="settings-empty-card cap-error-card">
          <span className="cap-error-text">{error}</span>
          <button type="button" className="btn ghost small" onClick={() => setError(null)}>
            <XIcon size={13} />
          </button>
        </div>
      )}

      {samplesOpen && (
        <div className="settings-section-card cap-import-card">
          <div className="settings-section-head">
            <span>Probe samples — retained 400 corpus</span>
            <div className="settings-section-actions">
              <button
                type="button"
                className="btn ghost small"
                disabled={!samples || samples.length === 0}
                title="Copy the full corpus as JSON — paste it to an issue report or the future MC-2.3 parser"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(JSON.stringify(samples ?? [], null, 2))
                    setSamplesCopied(true)
                    window.setTimeout(() => setSamplesCopied(false), 1800)
                  } catch {
                    setError('Could not write to the clipboard.')
                  }
                }}
              >
                <DownloadIcon size={13} /> {samplesCopied ? 'Copied!' : 'Copy JSON'}
              </button>
              <button
                type="button"
                className="btn ghost small"
                disabled={!samples || samples.length === 0}
                onClick={async () => {
                  await window.AnyBuff.clearProbeSamples()
                  await refreshSamples()
                }}
              >
                <XIcon size={13} /> Clear
              </button>
            </div>
          </div>
          <p className="hint">
            Every probe that ends <code>rejected</code> or <code>replay-conflict</code> retains the endpoint's
            raw body here (deduped, newest last, capped at 200). This is the corpus a future
            "must be one of …" parser will learn from — export it when reporting endpoint quirks.
          </p>
          {samples && samples.length > 0 ? (
            <div className="cap-import-lines cap-samples-list">
              {samples.map((s, i) => (
                <div key={`${s.key}-${s.rung}-${s.at}-${i}`} className={`cap-import-line ${s.verdict === 'replay-conflict' ? 'fail' : 'ok'}`}>
                  <span className="cap-import-line-model" title={`${s.key} — ${new Date(s.at).toLocaleString()}`}>
                    {s.model} · <code>{s.rung}</code>
                  </span>
                  <code className="cap-probe-body" title={s.body}>
                    {s.body.slice(0, 120)}
                    {s.body.length > 120 ? '…' : ''}
                  </code>
                </div>
              ))}
            </div>
          ) : (
            <p className="hint">No samples yet — probe a model and any 400 bodies will be kept here automatically.</p>
          )}
        </div>
      )}

      {importOpen && (
        <div className="settings-section-card cap-import-card">
          <div className="settings-section-head">
            <span>Import declarations</span>
            <div className="settings-section-actions">
              <button
                type="button"
                className="btn ghost small"
                title="Copy the research prompt to hand to any LLM (AnyBuff itself or an external one). It asks for vendor-documented rungs — never guesses."
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(buildMaintenancePrompt(providers))
                    setPromptCopied(true)
                    window.setTimeout(() => setPromptCopied(false), 1800)
                  } catch {
                    setError('Could not write to the clipboard.')
                  }
                }}
              >
                <DownloadIcon size={13} /> {promptCopied ? 'Copied!' : 'Copy maintenance prompt'}
              </button>
            </div>
          </div>
          <p className="hint">
            <strong>How to use:</strong> copy the maintenance prompt above, paste it into any LLM
            (with the model id filled in), and paste the JSON block it produces below. Only{' '}
            <code>modelCapabilities</code> is importable — provider URLs and keys are never touched.
            Each line applies independently.
          </p>
          <textarea
            className="cap-import-textarea"
            rows={6}
            spellCheck={false}
            placeholder={'{\n  "providerId": "goat",\n  "models": {\n    "deepseek/deepseek-v4.1-flash": {\n      "reasoning": { "efforts": ["low", "high", "max"], "defaultEffort": "high" },\n      "context": { "windowTokens": 128000 }\n    }\n  }\n}'}
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
          />
          <div className="cap-import-actions">
            <button type="button" className="btn primary small" disabled={!importText.trim()} onClick={() => void runImport()}>
              Apply
            </button>
            {importResult && (
              <span className={`cap-import-status ${importResult.ok ? 'ok' : 'partial'}`}>
                {importResult.ok
                  ? 'Applied'
                  : `${importResult.lines.filter((l) => !l.ok).length} line(s) failed`}
              </span>
            )}
          </div>
          {importResult && importResult.lines.length > 0 && (
            <div className="cap-import-lines">
              {importResult.lines.map((line) => (
                <div key={line.model} className={`cap-import-line ${line.ok ? 'ok' : 'fail'}`}>
                  <span className="cap-import-line-model">{line.model}</span>
                  <span className="cap-import-line-status">
                    {line.ok ? '✓' : `✗ ${line.error ?? 'failed'}`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {rows.length === 0 && providers.length === 0 ? (
        <div className="settings-empty-card">
          <p>No providers configured yet. Add a provider first, then maintain its models here.</p>
        </div>
      ) : (
        Array.from(grouped.entries()).map(([providerId, providerRows]) => {
          const meta = providers.find((p) => p.id === providerId)
          return (
            <div key={providerId} className="settings-section-card cap-provider-card">
              <div className="settings-section-head">
                <span>{meta?.label ?? providerId}</span>
                <span className="cap-provider-id">{providerId}</span>
              </div>
              <div className="cap-row-list">
                {providerRows.map((row) => (
                  <CapabilityRowView
                    key={row.key}
                    row={row}
                    expanded={expanded === row.key}
                    saving={saving}
                    onToggle={() => setExpanded(expanded === row.key ? null : row.key)}
                    onSave={saveRow}
                    onProbe={runProbe}
                    probeState={probe?.key === row.key ? probe : null}
                    onApplyProbe={applyProbeAccepted}
                    onDismissProbe={() => setProbe(null)}
                  />
                ))}
              </div>
            </div>
          )
        })
      )}
    </div>
  )
}

/**
 * MC-1.4: the maintenance prompt handed to an LLM (AnyBuff itself or an
 * external one) to research a model's rungs. Mirrors the §6 template in the
 * plan: vendor docs first, "unverified" over guessing, wire-literal rungs
 * (no xhigh→extra-high rewrites), omit-when-unsure, source URL last.
 */
export function buildMaintenancePrompt(providers: ProviderMeta[]): string {
  const providerList = providers
    .map((p) => `${p.id} (${p.label})`)
    .join('\n  - ')
  return `I use these OpenAI-compatible providers (id (label)):
  - ${providerList || '<none configured>'}

Please research the reasoning-effort values accepted by the model "<model id>" on the provider "<provider id>" above, plus any companion parameters.

Requirements:
1. Use the endpoint's official documentation as the primary source. If no official documentation exists, clearly say "unverified" — do not guess.
2. Output exactly one JSON block and nothing else, in this shape:
   { "providerId": "<provider id>", "models": { "<model id>": {
       "reasoning": { "efforts": [...], "defaultEffort": "...", "params": { ... } },
       "context": { "windowTokens": <number>, "outputTokens": <number> } } } }
3. For efforts, list the literal wire values the endpoint accepts (if the endpoint wants "xhigh", write "xhigh" — never rewrite it to "extra-high").
4. If you are not sure about windowTokens or outputTokens, omit that field rather than guessing.
5. End with one line: the source URL you used.`
}

function probeVerdictMeta(verdict: ProbeRungResult['verdict']): { label: string; className: string; title: string } {
  switch (verdict) {
    case 'accepted':
      return {
        label: '✓ accepted',
        className: 'cap-probe-ok',
        title: 'Both rounds clean: the rung is accepted and the tools-replay contract holds.'
      }
    case 'rejected':
      return {
        label: '✗ rejected',
        className: 'cap-probe-bad',
        title: 'The endpoint rejected this rung (see the raw body).'
      }
    case 'replay-conflict':
      return {
        label: '⚠ replay conflict',
        className: 'cap-probe-warn',
        title: 'Accepted alone, but the tools-bearing replay 400s on reasoning_content even though the probe sent it back as the vendor contract requires (ADR-26 class). The rung is incompatible with tool-use replay on this endpoint — check the raw body before declaring.'
      }
    case 'not-probed':
      return {
        label: '• not probed',
        className: 'cap-probe-info',
        title: 'The model produced no reasoning content, so the replay contract could not be exercised.'
      }
    default:
      return { label: '✗ error', className: 'cap-probe-bad', title: 'Transport/auth failure — inconclusive.' }
  }
}

function CapabilityRowView({
  row,
  expanded,
  saving,
  onToggle,
  onSave,
  onProbe,
  probeState,
  onApplyProbe,
  onDismissProbe
}: {
  row: CapabilityRow
  expanded: boolean
  saving: boolean
  onToggle: () => void
  onSave: (payload: {
    providerId: string
    model: string
    clear?: boolean
    reasoning?: {
      supported?: boolean
      efforts?: string[]
      defaultEffort?: string
      params?: Record<string, string | number | boolean>
    }
    context?: { windowTokens?: number; outputTokens?: number }
  }) => Promise<boolean>
  onProbe: (row: CapabilityRow, rungs: string[]) => Promise<void>
  probeState: ProbeState | null
  onApplyProbe: (p: ProbeState) => Promise<void>
  onDismissProbe: () => void
}) {
  const badge = sourceBadge(row)
  const [effortsText, setEffortsText] = useState((row.declared?.efforts ?? row.efforts).join(', '))
  const [defaultEffort, setDefaultEffort] = useState(row.defaultEffort ?? '')
  const [windowTokens, setWindowTokens] = useState(row.context?.windowTokens?.toString() ?? '')
  const [outputTokens, setOutputTokens] = useState(row.context?.outputTokens?.toString() ?? '')
  const [paramsText, setParamsText] = useState(
    row.declared?.params ? JSON.stringify(row.declared.params, null, 2) : ''
  )
  const [paramsError, setParamsError] = useState<string | null>(null)

  const declaredRungs = (row.declared?.efforts ?? row.efforts)
    .map((r) => r.trim())
    .filter(Boolean)
  const unknownRungs = declaredRungs.filter((r) => !COMMON_RUNGS.includes(r))
  const hasBothAliases =
    declaredRungs.includes('xhigh') && declaredRungs.includes('extra-high')

  const applyEdits = async () => {
    const efforts = effortsText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    // MC-1.5: params edited as raw JSON (scalar values only, verified host-side).
    let params: Record<string, string | number | boolean> | undefined
    if (paramsText.trim()) {
      try {
        const parsed: unknown = JSON.parse(paramsText)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setParamsError('params must be a JSON object')
          return
        }
        params = parsed as Record<string, string | number | boolean>
        setParamsError(null)
      } catch (e) {
        setParamsError(e instanceof Error ? e.message : String(e))
        return
      }
    } else {
      setParamsError(null)
    }
    const ok = await onSave({
      providerId: row.providerId,
      model: row.model,
      reasoning: {
        ...(efforts.length > 0 ? { efforts } : {}),
        ...(defaultEffort ? { defaultEffort } : {}),
        ...(row.declared?.supported !== undefined ? { supported: row.declared.supported } : {}),
        ...(params !== undefined ? { params } : {})
      },
      context: {
        ...(windowTokens && Number.isFinite(Number(windowTokens)) && Number(windowTokens) > 0
          ? { windowTokens: Number(windowTokens) }
          : {}),
        ...(outputTokens && Number.isFinite(Number(outputTokens)) && Number(outputTokens) > 0
          ? { outputTokens: Number(outputTokens) }
          : {})
      }
    })
    if (ok) onToggle()
  }

  const clearDeclaration = async () => {
    const ok = await onSave({
      providerId: row.providerId,
      model: row.model,
      clear: true
    })
    if (ok) onToggle()
  }

  return (
    <div className={`cap-row ${expanded ? 'expanded' : ''}`}>
      <div
        role="button"
        tabIndex={0}
        className="cap-row-head"
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
        title={badge.title}
      >
        <span className="cap-row-model" title={row.model}>
          {row.model}
        </span>
        <span className="cap-row-ladder">
          {row.efforts.length > 0 ? (
            row.efforts.map((e) => (
              <span key={e} className={`cap-rung ${COMMON_RUNGS.includes(e) ? '' : 'cap-rung-unknown'}`}>
                {e}
              </span>
            ))
          ) : (
            <span className="cap-rung cap-rung-fallback">fallback: low/high</span>
          )}
        </span>
        <span className={badge.className} title={badge.title}>
          {badge.label}
        </span>
        {row.source === 'declared' && row.overriddenSeed && (
          <span
            className="cap-badge cap-badge-seed-override"
            title={`Seed underneath (verified ${row.overriddenSeed.verifiedAt}): ${row.overriddenSeed.efforts.join('/')}`}
          >
            seed overridden
          </span>
        )}
        <button
          type="button"
          className="btn ghost small cap-probe-btn"
          title="Probe candidate rungs against the real endpoint (two rounds each: acceptance, then tools replay)"
          onClick={(e) => {
            e.stopPropagation()
            const candidates = Array.from(
              new Set([
                ...COMMON_RUNGS.filter((r) => r !== 'none' && r !== 'minimal'),
                'ultra',
                ...(row.declared?.efforts ?? []),
              ])
            )
            void onProbe(row, candidates)
          }}
        >
          <LightbulbIcon size={13} /> Probe
        </button>
        <EditIcon size={12} />
      </div>

      {probeState && (
        <div className="cap-probe-panel">
          <div className="settings-section-head">
            <span>
              Probe — {probeState.model}
              {probeState.running ? ' (probing… this sends tiny requests to your endpoint)' : ''}
            </span>
            <div className="settings-section-actions">
              {!probeState.running && (
                <button type="button" className="btn ghost small" onClick={() => onDismissProbe()}>
                  <XIcon size={13} /> Dismiss
                </button>
              )}
            </div>
          </div>
          {probeState.error && <p className="cap-warn">{probeState.error}</p>}
          {probeState.running && (
            <p className="hint">
              Two rounds per rung: plain acceptance, then tools-bearing history replay (the ADR-26
              contract only shows up in round two). Rungs are probed one at a time — with slow
              endpoints this can take a minute or more.
            </p>
          )}
          {probeState.results && probeState.results.length > 0 && (
            <div className="cap-probe-results">
              {probeState.results.map((r) => {
                const meta = probeVerdictMeta(r.verdict)
                return (
                  <div key={r.rung} className="cap-probe-result-row">
                    <span className="cap-probe-rung">{r.rung}</span>
                    <span className={`cap-probe-verdict ${meta.className}`} title={meta.title}>
                      {meta.label}
                      {r.status !== undefined ? ` (HTTP ${r.status})` : ''}
                    </span>
                    {r.bodyExcerpt && (
                      <code className="cap-probe-body" title={r.bodyExcerpt}>
                        {r.bodyExcerpt}
                      </code>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          {!probeState.running && probeState.note && <p className="hint">{probeState.note}</p>}
          {!probeState.running && (probeState.retainedCount ?? 0) > 0 && (
            <p className="hint">
              Retained {probeState.retainedCount} new sample
              {probeState.retainedCount === 1 ? '' : 's'} for the 400 corpus — see Samples in the panel
              header.
            </p>
          )}
          {!probeState.running && probeState.acceptedRungs && probeState.acceptedRungs.length > 0 && (
            <div className="cap-row-actions">
              <button
                type="button"
                className="btn primary small"
                disabled={saving}
                title={`Declare the accepted rungs: ${probeState.acceptedRungs.join(', ')}`}
                onClick={() => void onApplyProbe(probeState)}
              >
                <CheckCircleIcon size={13} /> Apply accepted ({probeState.acceptedRungs.length})
              </button>
            </div>
          )}
        </div>
      )}

      {expanded && (
        <div className="cap-row-editor">
          <label className="settings-field-label">
            Efforts (comma-separated, verbatim on the wire)
          </label>
          <input
            className="cap-input"
            value={effortsText}
            spellCheck={false}
            placeholder="low, high, max"
            onChange={(e) => setEffortsText(e.target.value)}
          />
          {unknownRungs.length > 0 && (
            <p className="cap-warn">
              Unrecognized rung{unknownRungs.length > 1 ? 's' : ''} <code>{unknownRungs.join(', ')}</code> —
              sent verbatim; may be a new rung or a typo (the endpoint fails loud).
            </p>
          )}
          {hasBothAliases && (
            <p className="cap-warn">
              <code>xhigh</code> and <code>extra-high</code> rank equal but are DIFFERENT wire strings.
            </p>
          )}

          <label className="settings-field-label">Default effort</label>
          <CustomSelect
            value={defaultEffort}
            onChange={(v) => setDefaultEffort(v === defaultEffort ? '' : v)}
            size="small"
            placeholder="None"
            options={[
              ...declaredRungs.map((r) => ({ value: r, label: r })),
              ...COMMON_RUNGS.filter((r) => !declaredRungs.includes(r)).map((r) => ({
                value: r,
                label: r
              }))
            ]}
          />

          <label className="settings-field-label">Context window (tokens)</label>
          <input
            className="cap-input"
            type="number"
            min={1}
            value={windowTokens}
            placeholder="e.g. 128000"
            onChange={(e) => setWindowTokens(e.target.value)}
          />
          <label className="settings-field-label">Max output (tokens)</label>
          <input
            className="cap-input"
            type="number"
            min={1}
            value={outputTokens}
            placeholder="e.g. 8192"
            onChange={(e) => setOutputTokens(e.target.value)}
          />

          <label className="settings-field-label">
            Extra reasoning params (JSON — keys go on the wire verbatim, e.g. thinking_budget)
          </label>
          <textarea
            className="cap-import-textarea"
            rows={3}
            spellCheck={false}
            placeholder={'{\n  "thinking_budget": 32000\n}'}
            value={paramsText}
            onChange={(e) => setParamsText(e.target.value)}
          />
          {paramsError && <p className="cap-warn">{paramsError}</p>}

          <div className="cap-row-actions">
            <button type="button" className="btn primary small" disabled={saving} onClick={() => void applyEdits()}>
              <CheckCircleIcon size={13} /> Apply
            </button>
            {row.source === 'declared' && row.overriddenSeed && (
              <button
                type="button"
                className="btn ghost small"
                disabled={saving}
                title={`Restore the verified seed: ${row.overriddenSeed.efforts.join('/')}`}
                onClick={() => {
                  setEffortsText(row.overriddenSeed!.efforts.join(', '))
                }}
              >
                <GaugeIcon size={13} /> Restore seed values
              </button>
            )}
            {row.source === 'declared' && (
              <button type="button" className="btn danger small" disabled={saving} onClick={() => void clearDeclaration()}>
                <TrashIcon size={13} /> Clear declaration
              </button>
            )}
            <button type="button" className="btn ghost small" onClick={onToggle}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
