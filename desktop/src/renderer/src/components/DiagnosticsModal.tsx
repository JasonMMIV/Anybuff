/**
 * #15 /diagnostics — 診斷面板（Modal Panel）。
 *
 * 顯示 host（main process）自身的 CPU / 記憶體(RSS+heap) / 運行時間 / 各
 * terminal 工具子程序 PID，用來排查「變慢、卡死在哪個指令」。資料來自
 * `AnyBuff:getDiagnostics` host channel（desktop IPC 或 WS 皆同）。
 *
 * - 彈出式獨立浮層，不污染對話串。
 * - 每 2 秒自動刷新 + 手動 Refresh。
 * - 一鍵複製診斷報告：只含 pid / 用量數字，不含任何指令內容、環境變數或
 *   API keys（ADR-12 自動脫敏）。
 * - Esc / 點擊 backdrop 關閉。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshIcon, XIcon } from './Icons'

interface DiagnosticsSnapshot {
  product?: string
  runtime?: string
  platform?: string
  architecture?: string
  pid?: number
  parentPid?: number
  uptimeSeconds?: number
  cpuUserMicros?: number
  cpuSystemMicros?: number
  memory?: {
    rss: number
    heapTotal: number
    heapUsed: number
    external: number
    arrayBuffers?: number
  }
  activeTools?: Array<{ pid: number; processGroupId?: number }>
  runningTaskId?: string | null
}

function isErrorEnvelope(value: unknown): value is { ok: false; error: string } {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { ok?: boolean }).ok === false &&
    typeof (value as { error?: unknown }).error === 'string'
  )
}

const fmtMB = (bytes?: number): string =>
  bytes === undefined ? '—' : `${(bytes / 1048576).toFixed(1)} MB`

function fmtClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`
  return `${m}m ${String(sec).padStart(2, '0')}s`
}

const cpuSeconds = (snap: DiagnosticsSnapshot): number =>
  ((snap.cpuUserMicros ?? 0) + (snap.cpuSystemMicros ?? 0)) / 1_000_000

export default function DiagnosticsModal({ onClose }: { onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [appVersion, setAppVersion] = useState('')
  const [copied, setCopied] = useState(false)
  /** Previous poll values → CPU% = Δcpu / Δwall. */
  const prevRef = useRef<{ cpu: number; at: number } | null>(null)
  const [cpuPct, setCpuPct] = useState<number | null>(null)
  const copiedTimerRef = useRef<number | null>(null)

  const fetchSnapshot = useCallback(async () => {
    try {
      const api = window.AnyBuff as unknown as { getDiagnostics?: () => Promise<unknown> }
      if (!api.getDiagnostics) {
        setError('Diagnostics are unavailable in this build.')
        return
      }
      const res = await api.getDiagnostics()
      if (isErrorEnvelope(res)) {
        setError(res.error)
        return
      }
      const snap = res as DiagnosticsSnapshot
      setSnapshot(snap)
      setError(null)

      const cpu = cpuSeconds(snap)
      const now = Date.now()
      const prev = prevRef.current
      if (prev && prev.at > 0) {
        const dtSec = (now - prev.at) / 1000
        if (dtSec > 0) {
          const delta = Math.max(0, cpu - prev.cpu)
          setCpuPct(Math.min(999, (delta / dtSec) * 100))
        }
      }
      prevRef.current = { cpu, at: now }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  // Live auto-refresh (2s) + Esc close.
  useEffect(() => {
    void fetchSnapshot()
    const timer = setInterval(() => void fetchSnapshot(), 2000)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      clearInterval(timer)
      window.removeEventListener('keydown', onKey)
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
    }
  }, [fetchSnapshot, onClose])

  // Best-effort app version for the report header.
  useEffect(() => {
    const api = window.AnyBuff as unknown as { getAppVersion?: () => Promise<{ version?: string }> }
    api.getAppVersion?.()
      .then((res) => {
        if (res?.version) setAppVersion(res.version)
      })
      .catch(() => {})
  }, [])

  const buildReport = (): string => {
    const snap = snapshot ?? ({} as DiagnosticsSnapshot)
    const mem = snap.memory
    const tools = snap.activeTools ?? []
    const lines = [
      '### AnyBuff process diagnostics',
      '',
      `- Captured: ${new Date().toLocaleString()}`,
      `- App version: ${appVersion || 'dev'}`,
      `- Host pid: ${snap.pid ?? '—'} (parent ${snap.parentPid ?? '—'})`,
      `- Runtime: ${snap.runtime ?? '—'} · ${snap.platform ?? '—'} ${snap.architecture ?? ''}`.trimEnd(),
      `- Host uptime: ${snap.uptimeSeconds === undefined ? '—' : fmtClock(snap.uptimeSeconds)}`,
      `- CPU: ${snap.cpuUserMicros === undefined ? '—' : `${(snap.cpuUserMicros / 1e6).toFixed(1)}s user`} / ${snap.cpuSystemMicros === undefined ? '—' : `${(snap.cpuSystemMicros / 1e6).toFixed(1)}s system`}${cpuPct !== null ? ` (~${cpuPct.toFixed(1)}% over last poll)` : ''}`,
      `- Memory: RSS ${fmtMB(mem?.rss)} · heap ${fmtMB(mem?.heapUsed)} / ${fmtMB(mem?.heapTotal)}`,
      `- Tool subprocesses: ${
        tools.length > 0
          ? tools.map((t) => `PID ${t.pid}${t.processGroupId ? ` (PGID ${t.processGroupId})` : ''}`).join(', ')
          : 'none running'
      }`,
      `- Active run: ${snap.runningTaskId ?? 'idle'}`,
      '',
      '(No API keys, command text, or environment are included — ADR-12 redaction.)',
    ]
    return lines.join('\n')
  }

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(buildReport())
      setCopied(true)
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setError('Could not write to the clipboard.')
    }
  }

  const mem = snapshot?.memory
  const tools = snapshot?.activeTools ?? []
  const busy = (snapshot?.runningTaskId ?? null) !== null

  return (
    <div className="modal-backdrop diagnostics-backdrop" onClick={onClose}>
      <div className="modal diagnostics-modal" onClick={(e) => e.stopPropagation()}>
        <header className="diagnostics-header">
          <div className="diagnostics-title">
            <span className="diag-label">System diagnostics</span>
            <h2>Diagnostics</h2>
          </div>
          <button type="button" className="mini-btn" onClick={onClose} title="Close (Esc)">
            <XIcon size={15} />
          </button>
        </header>

        {error && <div className="test-msg fail">{error}</div>}

        {snapshot ? (
          <>
            <div className="diag-grid">
              <div className="diag-stat">
                <span className="diag-label">Host uptime</span>
                <strong>{fmtClock(snapshot.uptimeSeconds ?? 0)}</strong>
              </div>
              <div className="diag-stat">
                <span className="diag-label">CPU (last poll)</span>
                <strong>{cpuPct !== null ? `${cpuPct.toFixed(1)}%` : '—'}</strong>
              </div>
              <div className="diag-stat">
                <span className="diag-label">Memory RSS</span>
                <strong>{fmtMB(mem?.rss)}</strong>
              </div>
              <div className="diag-stat">
                <span className="diag-label">Heap used</span>
                <strong>{fmtMB(mem?.heapUsed)}</strong>
              </div>
            </div>

            <dl className="diag-list">
              <div className="diag-row">
                <dt>Host pid</dt>
                <dd>
                  {snapshot.pid ?? '—'}
                  {snapshot.parentPid ? <span className="diag-muted"> (parent {snapshot.parentPid})</span> : null}
                </dd>
              </div>
              <div className="diag-row">
                <dt>Runtime</dt>
                <dd>
                  {snapshot.runtime ?? '—'} · {snapshot.platform ?? '—'} {snapshot.architecture ?? ''}
                </dd>
              </div>
              <div className="diag-row">
                <dt>CPU total</dt>
                <dd>
                  {(snapshot.cpuUserMicros ?? 0) / 1e6 >= 0
                    ? `${(snapshot.cpuUserMicros! / 1e6).toFixed(1)}s user + ${(snapshot.cpuSystemMicros! / 1e6).toFixed(1)}s system`
                    : '—'}
                </dd>
              </div>
              <div className="diag-row">
                <dt>Run state</dt>
                <dd>
                  <span className={`diag-dot ${busy ? 'busy' : 'idle'}`} />
                  {busy ? `active (task ${snapshot.runningTaskId})` : 'idle'}
                </dd>
              </div>
            </dl>

            <div className="diag-tools">
              <div className="diag-tools-head">
                <span className="diag-label">Terminal tool subprocesses</span>
                <span className="diag-muted">{tools.length} active</span>
              </div>
              {tools.length === 0 ? (
                <div className="diag-empty">None running — no stuck commands right now.</div>
              ) : (
                <ul className="diag-tool-list">
                  {tools.map((t) => (
                    <li key={t.pid}>
                      <code>PID {t.pid}</code>
                      {t.processGroupId ? <span className="diag-muted">· PGID {t.processGroupId}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <footer className="diagnostics-footer">
              <span className="hint">Auto-refreshes every 2s · no keys/command text included (ADR-12).</span>
              <div className="diagnostics-footer-actions">
                <button type="button" className="btn ghost small" onClick={() => void fetchSnapshot()} title="Refresh now">
                  <RefreshIcon size={12} /> Refresh
                </button>
                <button type="button" className="btn primary small" onClick={() => void handleCopy()} disabled={copied}>
                  {copied ? 'Copied ✓' : 'Copy report'}
                </button>
              </div>
            </footer>
          </>
        ) : (
          !error && <div className="diag-empty">Collecting diagnostics…</div>
        )}
      </div>
    </div>
  )
}
