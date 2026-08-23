import { useMemo, useState } from 'react'
import type { UiEvent } from '../../../preload'
import type { QueryIndexData, QueryIndexQuery, QueryIndexResult } from '../../../shared/codebase-index'

interface Props {
  events: UiEvent[]
  cwd: string | null
  onOpenFile: (path: string) => void
}

function formatAge(ageMs: number | undefined): string {
  if (typeof ageMs !== 'number' || ageMs < 0) return 'unknown age'
  const seconds = Math.floor(ageMs / 1000)
  if (seconds < 60) return `${seconds}s old`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m old`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h old`
  return `${Math.floor(hours / 24)}d old`
}

function queryTarget(query: QueryIndexQuery): string {
  if (query.mode === 'path') return `${query.from || 'auto'} → ${query.to || 'auto'}`
  if (query.mode === 'neighbors' || query.mode === 'references') return query.from || query.to || query.query || 'auto'
  return query.query || query.from || 'index'
}

function resultScore(result: QueryIndexResult, maxScore: number): number {
  if (typeof result.score !== 'number' || maxScore <= 0) return 0
  return Math.max(4, Math.min(100, (result.score / maxScore) * 100))
}

function joinProjectPath(cwd: string, relative: string): string {
  const separator = cwd.includes('\\') ? '\\' : '/'
  return `${cwd.replace(/[\\/]+$/, '')}${separator}${relative.split('/').join(separator)}`
}

function stateClass(state: string | undefined): string {
  if (state === 'ready') return 'ready'
  if (state === 'building' || state === 'stale') return 'building'
  if (state === 'disabled' || state === 'empty') return 'muted'
  if (state === 'failed' || state === 'degraded') return 'error'
  return 'muted'
}

function statusLabel(data: QueryIndexData): string {
  const state = data.status?.state
  if (state) return data.status?.refreshing ? `${state} · refreshing` : state
  if (data.message?.toLowerCase().includes('disabled')) return 'disabled'
  return data.results.length === 0 ? 'ready · no matches' : 'ready'
}

export default function CodebaseIndexPanel({ events, cwd, onOpenFile }: Props) {
  const [expandedPath, setExpandedPath] = useState<string | null>(null)

  const latest = useMemo(() => {
    let query: QueryIndexQuery | undefined
    let data: QueryIndexData | undefined
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (!query && event.queryInput) query = event.queryInput
      if (!data && event.queryIndex) data = event.queryIndex
      if (query && data) break
    }
    return { query, data }
  }, [events])

  const { query, data } = latest
  const results = data?.results ?? []
  const maxScore = Math.max(...results.map((result) => result.score ?? 0), 0)
  const state = data ? statusLabel(data) : 'waiting'
  const stateName = data?.status?.state ?? (data ? 'ready' : 'waiting')

  return (
    <div className="codebase-index-panel">
      <div className="index-scroll">
        {!query && !data ? (
          <div className="panel-empty index-empty">
            Run a task that searches the codebase and the ranked index results will appear here.
          </div>
        ) : (
          <>
            <div className="index-heading">
              <div>
                <span className="panel-eyebrow">Local graph index</span>
                <h3>Codebase Index</h3>
              </div>
              <span className={`index-state ${stateClass(stateName)}`}>
                <span className="index-state-dot" /> {state}
              </span>
            </div>

            {query && (
              <div className="index-query-card">
                <div className="index-query-mode">{query.mode ?? 'search'}</div>
                <div className="index-query-target" title={queryTarget(query)}>{queryTarget(query)}</div>
                <div className="index-query-filters">
                  {typeof query.limit === 'number' && <span>limit {query.limit}</span>}
                  {query.fileTypes?.length ? <span>{query.fileTypes.map((type) => `.${type}`).join(', ')}</span> : null}
                  {query.pathPrefixes?.length ? <span>{query.pathPrefixes.join(', ')}</span> : null}
                </div>
              </div>
            )}

            {data && (
              <>
                <div className="index-summary-grid">
                  <div className="index-summary-card">
                    <strong>{data.totalIndexed ?? '—'}</strong>
                    <span>indexed files</span>
                  </div>
                  <div className="index-summary-card">
                    <strong>{results.length}</strong>
                    <span>matches</span>
                  </div>
                  <div className="index-summary-card">
                    <strong>{formatAge(data.indexAge)}</strong>
                    <span>snapshot age</span>
                  </div>
                </div>

                <div className="index-status-line">
                  <span>{data.status?.semantic && `Semantic: ${data.status.semantic}`}</span>
                  {data.snapshot?.snapshotId && <span>Snapshot {data.snapshot.snapshotId.slice(0, 10)}…</span>}
                </div>

                {data.message && <p className="index-message">{data.message}</p>}
                {data.status?.coverage?.truncated && (
                  <div className="index-warning">
                    Partial coverage: {data.status.coverage.skippedFiles ?? 'some'} file(s) skipped
                    {data.status.coverage.maxFiles ? ` at the ${data.status.coverage.maxFiles}-file limit` : ''}.
                  </div>
                )}
                {data.status?.lastBuildError && (
                  <div className="index-warning error">
                    Build error ({data.status.lastBuildError.stage ?? 'unknown'}): {data.status.lastBuildError.message ?? 'unknown error'}
                  </div>
                )}

                <div className="index-results-head">
                  <span>Ranked results</span>
                  {results.length > 0 && <span>{results.length} shown</span>}
                </div>
                {results.length === 0 ? (
                  <div className="panel-empty index-no-results">No indexed files matched this query.</div>
                ) : (
                  <div className="index-results">
                    {results.map((result, index) => {
                      const expanded = expandedPath === result.path
                      return (
                        <div key={`${result.path}-${index}`} className={`index-result ${expanded ? 'expanded' : ''}`}>
                          <button className="index-result-head" onClick={() => setExpandedPath(expanded ? null : result.path)} title="Show index details">
                            <span className="index-rank">{index + 1}</span>
                            <span className="index-result-path">{result.path}</span>
                            <span className="index-score">{typeof result.score === 'number' ? result.score.toFixed(2) : '—'}</span>
                            <span className="index-expand">{expanded ? '⌃' : '⌄'}</span>
                          </button>
                          <div className="index-score-track">
                            <span style={{ width: `${resultScore(result, maxScore)}%` }} />
                          </div>
                          <div className="index-result-meta">
                            {(result.matchedOn ?? []).map((match) => <span key={match} className="index-badge">{match}</span>)}
                            <button className="index-open-file" onClick={() => cwd && onOpenFile(joinProjectPath(cwd, result.path))} disabled={!cwd}>
                              Open file
                            </button>
                          </div>
                          {expanded && (
                            <div className="index-result-details">
                              {result.explanation && <p>{result.explanation}</p>}
                              {result.symbols?.length ? <div><span className="index-detail-label">Symbols</span><span>{result.symbols.join(' · ')}</span></div> : null}
                              {result.headings?.length ? <div><span className="index-detail-label">Headings</span><span>{result.headings.join(' · ')}</span></div> : null}
                              {result.matchedSnippets?.length ? <div><span className="index-detail-label">Snippets</span><span>{result.matchedSnippets.join(' · ')}</span></div> : null}
                              {result.relatedFiles?.length ? (
                                <div>
                                  <span className="index-detail-label">Related files</span>
                                  <div className="index-related-list">
                                    {result.relatedFiles.slice(0, 8).map((related) => (
                                      <button key={related.path} className="index-related" onClick={() => cwd && onOpenFile(joinProjectPath(cwd, related.path))} disabled={!cwd} title={related.reason}>
                                        {related.path}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}

                {data.status?.diagnostics?.length ? (
                  <div className="index-diagnostics">
                    <span className="index-detail-label">Diagnostics</span>
                    {data.status.diagnostics.slice(0, 4).map((diagnostic, index) => (
                      <span key={`${diagnostic.filePath}-${index}`}>{diagnostic.filePath ?? 'unknown file'}: {diagnostic.message ?? 'parser warning'}</span>
                    ))}
                  </div>
                ) : null}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
