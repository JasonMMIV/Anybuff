import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpIcon, LightbulbIcon, PlusIcon, ShieldAlertIcon, ShieldCheckIcon, SparklesIcon, StopIcon, XIcon } from './Icons'
import CustomSelect from './CustomSelect'

export interface Attachment {
  path: string
  name: string
  isDir: boolean
  /** true = path relative to cwd (@ reference); false = absolute path (file picker) */
  isRelative: boolean
}

export interface SkillInfo {
  name: string
  description: string
  path: string
  source: 'project' | 'home'
}

/** Root agent mode shown in the composer toggle ('plan' runs the read-only base2-plan agent). */
export type AgentMode = 'default' | 'plan'

interface ProviderOption {
  id: string
  label: string
  models: string[]
}

interface ComposerProps {
  prompt: string
  onChange: (v: string) => void
  onSend: () => void
  onStop: () => void
  onNewTask: () => void
  onInitRequest: () => void
  onSearchRequest: () => void
  running: boolean
  stopping?: boolean
  /** Another conversation's run is active — sending is temporarily blocked. */
  sendBlocked?: boolean
  sendBlockedHint?: string
  disabled: boolean
  attachments: Attachment[]
  onAttachFiles: () => void
  onAttachFilesPath: (relPath: string) => void
  onRemoveAttachment: (path: string) => void
  providers: ProviderOption[]
  activeModel: string
  onModelChange: (model: string) => void
  reasoningEffort: string
  onReasoningChange: (effort: string) => void
  agentMode: AgentMode
  onAgentModeChange: (mode: AgentMode) => void
  tokenUsage: { used: number; max: number } | null
  totalCost: number
  fileCandidates: string[]
  skills: SkillInfo[]
  /** Increment to programmatically focus the textarea (e.g. after Revert restores a message). */
  focusSignal?: number
}

import { getReasoningOptionsForModel } from '../utils/reasoning'

const SLASH_COMMANDS: { id: string; label: string; description: string }[] = [
  { id: 'new-task', label: 'new-task', description: 'Start a new task' },
  { id: 'init', label: 'init', description: 'Create a custom agent visually' },
  { id: 'search', label: 'search', description: 'Search messages and files' }
]

type Mention =
  | { kind: 'file'; query: string }
  | { kind: 'skill'; query: string }
  | null

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function TokenRing({ used, max, running }: { used: number; max: number; running: boolean }) {
  const pct = max > 0 ? Math.min(100, (used / max) * 100) : 0
  const colorClass = pct >= 90 ? 'tok-danger' : pct >= 70 ? 'tok-warn' : 'tok-normal'

  const size = 15
  const strokeWidth = 2.2
  const center = size / 2
  const radius = center - strokeWidth / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (pct / 100) * circumference

  const title = `Context: ${used.toLocaleString()} / ${max.toLocaleString()} tokens (${pct.toFixed(1)}%)`
  const text = `${formatTokens(used)}/${formatTokens(max)}`

  return (
    <div className="token-ring-wrap" title={title}>
      <svg className={`token-ring-svg${running ? ' pulsing' : ''}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          className="token-ring-bg"
          cx={center}
          cy={center}
          r={radius}
          strokeWidth={strokeWidth}
        />
        <circle
          className={`token-ring-bar ${colorClass}`}
          cx={center}
          cy={center}
          r={radius}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform={`rotate(-90 ${center} ${center})`}
        />
      </svg>
      <span className="token-text">{text}</span>
    </div>
  )
}

export default function Composer(props: ComposerProps) {
  const {
    prompt,
    onChange,
    onSend,
    onStop,
    onNewTask,
    onInitRequest,
    onSearchRequest,
    running,
    stopping,
    sendBlocked,
    sendBlockedHint,
    disabled,
    attachments,
    onAttachFiles,
    onRemoveAttachment,
    providers,
    activeModel,
    onModelChange,
    reasoningEffort,
    onReasoningChange,
    agentMode,
    onAgentModeChange,
    tokenUsage,
    totalCost,
    fileCandidates,
    skills,
    focusSignal
  } = props

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const menuItemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [mention, setMention] = useState<Mention>(null)
  const [mentionIndex, setMentionIndex] = useState(0)

  // Focus the input when asked (e.g. after Revert restores the message for editing)
  useEffect(() => {
    if (!focusSignal) return
    const el = textareaRef.current
    if (!el) return
    el.focus()
    const len = el.value.length
    el.setSelectionRange(len, len)
  }, [focusSignal])

  // Keep the highlighted item in view when navigating with arrow keys
  useEffect(() => {
    menuItemRefs.current[mentionIndex]?.scrollIntoView({ block: 'nearest' })
  }, [mentionIndex, mention?.kind])

  // Auto-grow with text lines (max 184px, then scroll internally)
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 184)}px`
  }, [prompt])

  // Detect the @file or /skill token being typed before the caret
  const detectMention = (value: string, caret: number): Mention => {
    const before = value.slice(0, caret)
    const wordMatch = before.match(/(@[\w./\\-]*|\/[\w:./\\-]*)$/)
    if (!wordMatch) return null
    const token = wordMatch[1]
    if (token.startsWith('@')) {
      return { kind: 'file', query: token.slice(1).toLowerCase() }
    }
    if (token.startsWith('/') && (caret === token.length || before[caret - token.length - 1] === '\n' || /\s$/.test(before.slice(0, caret - token.length) || ' '))) {
      return { kind: 'skill', query: token.slice(1).toLowerCase() }
    }
    return null
  }

  const update = (value: string, caret: number) => {
    onChange(value)
    const next = detectMention(value, caret)
    setMention(next)
    setMentionIndex(0)
  }

  // Replace the token before the caret
  const replaceToken = (replacement: string) => {
    const el = textareaRef.current
    if (!el) return
    const caret = el.selectionStart
    const before = el.value.slice(0, caret)
    const after = el.value.slice(caret)
    const tokenMatch = before.match(/(@[\w./\\-]*|\/[\w:./\\-]*)$/)
    if (!tokenMatch) return
    const start = caret - tokenMatch[1].length
    const value = before.slice(0, start) + replacement + after
    onChange(value)
    setMention(null)
    // Restore focus after updating the caret
    requestAnimationFrame(() => {
      el.focus()
      const pos = start + replacement.length
      el.setSelectionRange(pos, pos)
    })
  }

  const filteredFiles = mention?.kind === 'file' ? fileCandidates.filter((f) => f.toLowerCase().includes(mention.query)) : []
  const filteredSkills =
    mention?.kind === 'skill'
      ? [...skills.filter((s) => s.name.toLowerCase().includes(mention.query)), ...SLASH_COMMANDS.filter((c) => c.id.includes(mention.query))]
      : []
  const fileItems = filteredFiles.slice(0, 50)
  const skillItems = filteredSkills.slice(0, 50)
  const mentionList = mention?.kind === 'file' ? fileItems : skillItems

  const selectFile = (relPath: string) => {
    replaceToken(`@${relPath} `)
    // Also add as an attachment (content read on send)
    if (!attachments.some((a) => a.path === relPath)) {
      props.onAttachFilesPath(relPath)
    }
  }

  const selectSkill = (skill: SkillInfo | { id: string }) => {
    if ('id' in skill && !('path' in skill)) {
      // Built-in command
      replaceToken('')
      if (skill.id === 'new-task') onNewTask()
      else if (skill.id === 'init') onInitRequest()
      else if (skill.id === 'search') onSearchRequest()
      return
    }
    replaceToken(`/skill:${(skill as SkillInfo).name} `)
  }

  const modelLabel = useMemo(() => {
    const [pid, ...rest] = activeModel.split('/')
    const provider = providers.find((p) => p.id === pid)
    return provider ? `${provider.label} · ${rest.join('/') || pid}` : activeModel || 'Select model'
  }, [activeModel, providers])

  return (
    <div className="composer-wrap">
      {attachments.length > 0 && (
        <div className="attachment-strip">
          {attachments.map((att) => (
            <span key={att.path} className="attachment-chip">
              {att.isDir ? '📁' : '📄'} {att.name}
              <button className="chip-x" onClick={() => onRemoveAttachment(att.path)} title="Remove">
                <XIcon size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="composer">
        <button className="attach-btn" onClick={onAttachFiles} disabled={running} title="Attach files">
          <PlusIcon size={16} />
        </button>

        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(e) => update(e.target.value, e.target.selectionStart)}
          onKeyDown={(e) => {
            // Guard against IME composition on Windows/CJK keyboards:
            // do not submit or trigger actions while user is selecting/confirming IME candidates
            if (e.nativeEvent.isComposing || e.keyCode === 229) return

            if (mention) {
              const list = mentionList
              if (list.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setMentionIndex((i) => (i + 1) % list.length)
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setMentionIndex((i) => (i - 1 + list.length) % list.length)
                  return
                }
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const item = list[mentionIndex]
                  if (mention.kind === 'file') selectFile(item as string)
                  else selectSkill(item as SkillInfo | { id: string })
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setMention(null)
                  return
                }
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              // While a run is in flight App.tsx routes this into the message
              // queue instead of rejecting it (#2 執行中訊息佇列).
              if (!disabled) onSend()
            }
          }}
          onClick={() => setMention(detectMention(prompt, textareaRef.current?.selectionStart ?? prompt.length))}
          placeholder="Type a message -/ for skills, @ for files"
          rows={1}
          disabled={disabled}
        />

        {mention && (
          <div className="mention-menu">
            {mention.kind === 'file' &&
              (fileItems.length === 0 ? (
                <div className="mention-empty">No matching files</div>
              ) : (
                fileItems.map((f, i) => (
                  <button
                    key={f}
                    ref={(el) => {
                      menuItemRefs.current[i] = el
                    }}
                    className={`mention-item ${i === mentionIndex ? 'selected' : ''}`}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      selectFile(f)
                    }}
                    onMouseEnter={() => setMentionIndex(i)}
                  >
                    <span className="mention-icon">📄</span>
                    <span className="mention-text">{f}</span>
                  </button>
                ))
              ))}

            {mention.kind === 'skill' &&
              (skillItems.length === 0 ? (
                <div className="mention-empty">No matching skills</div>
              ) : (
                skillItems.map((item, i) => (
                  <button
                    key={'path' in item ? `${item.path}::${item.name}` : item.id}
                    ref={(el) => {
                      menuItemRefs.current[i] = el
                    }}
                    className={`mention-item ${i === mentionIndex ? 'selected' : ''}`}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      selectSkill(item as SkillInfo | { id: string })
                    }}
                    onMouseEnter={() => setMentionIndex(i)}
                  >
                    <span className="mention-icon">{'path' in item ? '⚡' : '⌘'}</span>
                    <span className="mention-text">
                      {'path' in item ? item.name : (item as { id: string; label: string }).label}
                    </span>
                    {'description' in item && item.description && (
                      <span className="mention-desc">{item.description}</span>
                    )}
                  </button>
                ))
              ))}
          </div>
        )}

        {running ? (
          <>
            {/* Queue-send stays available mid-run: the message parks in the
                execution queue and fires when the current turn ends. */}
            <button
              className="btn primary send-btn queue-send-btn"
              onClick={onSend}
              disabled={!prompt.trim()}
              title="Queue this message — it will send when the current turn finishes"
            >
              <PlusIcon size={14} />
            </button>
            <button className={`btn danger send-btn stop-btn ${stopping ? 'stopping' : ''}`} onClick={onStop} disabled={stopping} title={stopping ? "Stopping..." : "Stop"}>
              <StopIcon size={14} />
            </button>
          </>
        ) : (
          <button
            className="btn primary send-btn"
            onClick={onSend}
            disabled={disabled || !prompt.trim()}
            title={sendBlocked ? 'Another task is running — this will be queued' : 'Send (Enter)'}
          >
            <ArrowUpIcon size={16} />
          </button>
        )}
      </div>

      <div className="composer-toolbar">
        <div className="toolbar-left">
          <CustomSelect
            value={agentMode}
            onChange={(mode) => onAgentModeChange(mode as AgentMode)}
            disabled={running}
            size="small"
            placement="top"
            options={[
              { value: 'default', label: 'Full Access', icon: <ShieldAlertIcon size={13} /> },
              { value: 'plan', label: 'Read Only', icon: <ShieldCheckIcon size={13} /> }
            ]}
            title="Agent mode"
          />

          <CustomSelect
            icon={<SparklesIcon size={13} />}
            value={activeModel}
            onChange={onModelChange}
            disabled={running}
            size="small"
            placement="top"
            placeholder={providers.length === 0 ? 'No provider configured' : 'Select model'}
            options={providers.flatMap((p) =>
              p.models.map((m) => ({
                value: `${p.id}/${m}`,
                label: `${p.label} / ${m}`
              }))
            )}
            title="Model"
          />

          <CustomSelect
            icon={<LightbulbIcon size={13} />}
            value={reasoningEffort}
            onChange={onReasoningChange}
            disabled={running}
            size="small"
            placement="top"
            options={getReasoningOptionsForModel(activeModel).map((r) => ({
              value: r,
              label: r === 'default' ? 'Default' : r.charAt(0).toUpperCase() + r.slice(1).replace('-', ' ')
            }))}
            title="Reasoning level"
          />
        </div>

        <div className="toolbar-right">
          {totalCost > 0 && <span className="cost-badge" title="Total cost">${totalCost.toFixed(4)}</span>}
          {tokenUsage && tokenUsage.max > 0 && (
            <TokenRing used={tokenUsage.used} max={tokenUsage.max} running={running} />
          )}
        </div>
      </div>
    </div>
  )
}
