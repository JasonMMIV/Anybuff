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
import { formatTokenCount } from '../utils/format-tokens'
import { diffCapabilityEdits } from '../utils/capability-edits'

/**
 * ADR-27 — Model Capabilities tab (MC-1.1/1.2/1.4).
 *
 * Every provider model gets a row: its effective reasoning ladder, a source
 * badge (已查證 verified seed / 自訂 declared / 未識別 unknown — §2.5), and
 * context overrides. Rows expand into an editor; literals pass VERBATIM —
 * `xhigh` and `extra-high` are different wire strings and no layer here
 * rewrites them (§2.1). Unknown rungs warn but never block (§2.4). The
 * collapsed row stays compact (model + ladder + badge); the EDITOR pre-fills
 * the effective context/output and default effort, tagging each field with its
 * provenance, and only fields the user actually changes are persisted — so
 * untouched values keep inheriting from models.dev.
 */

export interface CapabilityRow {
  providerId: string
  model: string
  key: string
  efforts: string[]
  source: 'verified' | 'declared' | 'catalog' | 'unknown'
  verifiedAt?: string
  verifiedBy?: string
  declared?: {
    efforts?: string[]
    defaultEffort?: string
    supported?: boolean
    params?: Record<string, string | number | boolean>
    /** ADR-32: named reasoning wire dialect (`auto` when absent). */
    wire?: string
    /** ADR-32: thinking budget for the budget/thinking_budget dialects. */
    budgetTokens?: number
  }
  overriddenSeed?: { efforts: string[]; verifiedAt: string }
  context?: { windowTokens?: number; outputTokens?: number }
  /** Effective values shown to the user (settings first, then models.dev). */
  effectiveContext?: { windowTokens?: number; outputTokens?: number }
  contextSource?: 'declared' | 'catalog'
  defaultEffort?: string
  /** ADR-31: models.dev provenance — present iff source === 'catalog'. */
  catalog?: {
    snapshotAt: string
    fetchedAt?: string
    matchedBy: string
    confidence: number
  }
}

interface ProviderMeta {
  id: string
  label: string
  /** ADR-32: dialect choices are protocol-specific. */
  type?: 'openai-compatible' | 'anthropic-compatible'
}

const COMMON_RUNGS = ['low', 'medium', 'high', 'xhigh', 'extra-high', 'max', 'minimal', 'none']

/** ADR-32: dialect lists mirror `REASONING_WIRE_DIALECTS` (UI subset).
 *  `chat.reasoning_obj` is deliberately config-only. */
const OPENAI_WIRE_OPTIONS = [
  { value: 'auto', label: 'Auto (current behavior)' },
  { value: 'chat.effort', label: 'reasoning_effort' },
  { value: 'chat.thinking_budget', label: 'thinking_budget (budget only)' },
  { value: 'chat.enable_thinking', label: 'enable_thinking + thinking_budget' },
  { value: 'chat.none', label: 'None (write no reasoning key)' }
]
const ANTHROPIC_WIRE_OPTIONS = [
  { value: 'auto', label: 'Auto (current behavior)' },
  { value: 'claude.effort', label: 'output_config.effort (low/medium/high)' },
  { value: 'claude.budget', label: 'thinking.budget_tokens' },
  { value: 'claude.none', label: 'None (write no reasoning key)' }
]
const BUDGET_WIRES = new Set(['chat.thinking_budget', 'chat.enable_thinking', 'claude.budget'])

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
  if (row.source === 'catalog') {
    const provenance = row.catalog
    return {
      label: 'Catalog',
      className: 'cap-badge cap-badge-catalog',
      title: provenance
        ? `models.dev ${provenance.matchedBy} match (${Math.round(
            provenance.confidence * 100
          )}%) — snapshot ${provenance.snapshotAt.slice(0, 10)}${
            provenance.fetchedAt
              ? `, refreshed ${provenance.fetchedAt.slice(0, 10)}`
              : ''
          }. Declare rungs to override it.`
        : 'models.dev catalog value — declare rungs to override it.'
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

  const refresh = useCallback(async (opts?: { refresh?: boolean }) => {
    try {
      const result = (await window.AnyBuff.listModelCapabilities(opts)) as {
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
        wire?: string
        budgetTokens?: number
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
          <button
            type="button"
            className="btn ghost small"
            title="Fetch the latest model information from models.dev and reload this list"
            onClick={() => void refresh({ refresh: true })}
          >
            <RefreshIcon size={13} /> Refresh
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
        <strong>Catalog</strong> = models.dev entry, resolved up front and never written to your settings;{' '}
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
                    providerType={meta?.type}
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
  onDismissProbe,
  providerType
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
      wire?: string
      budgetTokens?: number
    }
    context?: { windowTokens?: number; outputTokens?: number }
  }) => Promise<boolean>
  onProbe: (row: CapabilityRow, rungs: string[]) => Promise<void>
  probeState: ProbeState | null
  onApplyProbe: (p: ProbeState) => Promise<void>
  onDismissProbe: () => void
  providerType?: 'openai-compatible' | 'anthropic-compatible'
}) {
  const badge = sourceBadge(row)
  const effectiveContext = row.effectiveContext ?? row.context
  // Per-field provenance for the editor labels: a declared value is yours, an
  // undeclared one is inherited from models.dev (settings always win field by
  // field, so one field can be declared while its sibling is inherited).
  const windowFromCatalog =
    effectiveContext?.windowTokens !== undefined && row.context?.windowTokens === undefined
  const outputFromCatalog =
    effectiveContext?.outputTokens !== undefined && row.context?.outputTokens === undefined
  // The editor starts from the EFFECTIVE values (what the menu/runtime use).
  // applyEdits compares against these so unchanged fields are never persisted
  // as declarations — they keep inheriting from settings/models.dev.
  const initialEfforts = (row.declared?.efforts ?? row.efforts).join(', ')
  const initialDefaultEffort = row.defaultEffort ?? ''
  const initialWindowTokens = effectiveContext?.windowTokens?.toString() ?? ''
  const initialOutputTokens = effectiveContext?.outputTokens?.toString() ?? ''
  const initialParamsText = row.declared?.params
    ? JSON.stringify(row.declared.params, null, 2)
    : ''
  const initialWire = row.declared?.wire ?? 'auto'
  const initialBudgetTokens = row.declared?.budgetTokens?.toString() ?? ''
  const [effortsText, setEffortsText] = useState(initialEfforts)
  const [defaultEffort, setDefaultEffort] = useState(initialDefaultEffort)
  const [windowTokens, setWindowTokens] = useState(initialWindowTokens)
  const [outputTokens, setOutputTokens] = useState(initialOutputTokens)
  const [paramsText, setParamsText] = useState(initialParamsText)
  const [paramsError, setParamsError] = useState<string | null>(null)
  const [wire, setWire] = useState(initialWire)
  const [budgetTokens, setBudgetTokens] = useState(initialBudgetTokens)
  const [editError, setEditError] = useState<string | null>(null)

  // Re-sync the editor when the row is refreshed (probe → apply, another save).
  // Without this the baseline moves while the inputs keep their old values, so
  // the next Apply would treat untouched fields as changed and overwrite data.
  useEffect(() => {
    setEffortsText(initialEfforts)
    setDefaultEffort(initialDefaultEffort)
    setWindowTokens(initialWindowTokens)
    setOutputTokens(initialOutputTokens)
    setParamsText(initialParamsText)
    setWire(initialWire)
    setBudgetTokens(initialBudgetTokens)
    setParamsError(null)
    setEditError(null)
  }, [row])
  const wireOptions =
    providerType === 'anthropic-compatible'
      ? ANTHROPIC_WIRE_OPTIONS
      : OPENAI_WIRE_OPTIONS
  const showBudget = BUDGET_WIRES.has(wire)

  const declaredRungs = (row.declared?.efforts ?? row.efforts)
    .map((r) => r.trim())
    .filter(Boolean)
  const unknownRungs = declaredRungs.filter((r) => !COMMON_RUNGS.includes(r))
  const hasBothAliases =
    declaredRungs.includes('xhigh') && declaredRungs.includes('extra-high')

  const applyEdits = async () => {
    const diff = diffCapabilityEdits(
      {
        efforts: initialEfforts,
        defaultEffort: initialDefaultEffort,
        wire: initialWire,
        budgetTokens: initialBudgetTokens,
        windowTokens: initialWindowTokens,
        outputTokens: initialOutputTokens,
        paramsText: initialParamsText,
      },
      {
        efforts: effortsText,
        defaultEffort,
        wire,
        budgetTokens,
        windowTokens,
        outputTokens,
        paramsText,
      }
    )
    if (!diff.changed) {
      onToggle()
      return
    }
    if (diff.windowChanged && !(Number(windowTokens) > 0)) {
      setEditError(
        'Context window must be a positive number. Use “Clear declaration” to remove an override.'
      )
      return
    }
    if (diff.outputChanged && !(Number(outputTokens) > 0)) {
      setEditError(
        'Max output must be a positive number. Use “Clear declaration” to remove an override.'
      )
      return
    }
    if (diff.budgetChanged && !(Number(budgetTokens) > 0)) {
      setEditError('Thinking budget must be a positive number.')
      return
    }
    if (diff.paramsChanged && !paramsText.trim()) {
      setEditError('Clearing params is not supported — use “Clear declaration”.')
      return
    }
    setEditError(null)
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
        ...(diff.effortsChanged && diff.efforts.length > 0 ? { efforts: diff.efforts } : {}),
        ...(diff.defaultEffortChanged && defaultEffort ? { defaultEffort } : {}),
        ...(row.declared?.supported !== undefined ? { supported: row.declared.supported } : {}),
        ...(diff.paramsChanged && params !== undefined ? { params } : {}),
        // ADR-32: only send an explicit dialect when it differs from what is
        // stored ('auto' is an explicit value too — picking it clears a
        // previously stored dialect). An untouched row stays absent = keep.
        ...(diff.wireChanged ? { wire } : {}),
        ...(diff.budgetChanged &&
        showBudget &&
        budgetTokens &&
        Number.isFinite(Number(budgetTokens)) &&
        Number(budgetTokens) > 0
          ? { budgetTokens: Math.floor(Number(budgetTokens)) }
          : {})
      },
      context: {
        ...(diff.windowChanged &&
        windowTokens &&
        Number.isFinite(Number(windowTokens)) &&
        Number(windowTokens) > 0
          ? { windowTokens: Number(windowTokens) }
          : {}),
        ...(diff.outputChanged &&
        outputTokens &&
        Number.isFinite(Number(outputTokens)) &&
        Number(outputTokens) > 0
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
          <p className="cap-hint">
            Showing the current effective values. Only fields you change are saved; everything
            else keeps inheriting from settings or models.dev.
          </p>
          <label className="settings-field-label">Reasoning parameter format</label>
          <CustomSelect
            value={wire}
            onChange={setWire}
            size="small"
            options={wireOptions}
          />
          <p className="cap-hint">
            A wrong format may be rejected by the provider (400). A custom request body
            overrides this setting. <code>None</code> writes no reasoning key at all —
            it never disables reasoning.
          </p>
          {showBudget && (
            <>
              <label className="settings-field-label">Thinking budget (tokens)</label>
              <input
                className="cap-input"
                type="number"
                min={1}
                value={budgetTokens}
                placeholder="e.g. 32000"
                onChange={(e) => setBudgetTokens(e.target.value)}
              />
              <p className="cap-hint">Budget dialects do not need an effort pick.</p>
            </>
          )}

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

          <label className="settings-field-label">
            Context window (tokens)
            {effectiveContext?.windowTokens !== undefined && (
              <span
                className="cap-src-tag"
                title={`Currently in effect: ${formatTokenCount(
                  effectiveContext.windowTokens
                )} tokens`}
              >
                {windowFromCatalog ? 'models.dev' : 'settings'}
              </span>
            )}
          </label>
          <input
            className="cap-input"
            type="number"
            min={1}
            value={windowTokens}
            placeholder="e.g. 128000"
            onChange={(e) => setWindowTokens(e.target.value)}
          />
          <label className="settings-field-label">
            Max output (tokens)
            {effectiveContext?.outputTokens !== undefined && (
              <span
                className="cap-src-tag"
                title={`Currently in effect: ${formatTokenCount(
                  effectiveContext.outputTokens
                )} tokens`}
              >
                {outputFromCatalog ? 'models.dev' : 'settings'}
              </span>
            )}
          </label>
          <input
            className="cap-input"
            type="number"
            min={1}
            value={outputTokens}
            placeholder="e.g. 8192"
            onChange={(e) => setOutputTokens(e.target.value)}
          />
          {(windowFromCatalog || outputFromCatalog) && (
            <p className="cap-hint">
              Values tagged <strong>models.dev</strong> are inherited — editing one stores an
              override for this route; an untouched field keeps inheriting.
            </p>
          )}

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
          {editError && <p className="cap-warn">{editError}</p>}

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
