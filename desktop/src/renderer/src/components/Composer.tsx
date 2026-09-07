import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpIcon, ChatIcon, HammerIcon, LightbulbIcon, ListIcon, PaperclipIcon, PlusIcon, SparklesIcon, StopIcon, XIcon } from './Icons'
import CustomSelect from './CustomSelect'

export interface Attachment {
  path: string
  name: string
  isDir: boolean
  /** true = path relative to cwd (@ reference); false = absolute path (file picker) */
  isRelative: boolean
  /** #4 set for image attachments (rendered as thumbnails, sent as base64). */
  isImage?: boolean
  /** #4 preview data URL for image attachments (renderer-side only). */
  previewUrl?: string
}

export interface SkillInfo {
  name: string
  description: string
  path: string
  source: 'project' | 'home'
}

/** Root agent mode shown in the composer toggle. 'default' runs the
 *  full-access base2 root (Build); 'plan' runs the read-only base2-plan
 *  agent (Plan); 'chat' runs the lightweight no-filesystem Buffy Chat
 *  (base-chat) root. */
export type AgentMode = 'default' | 'plan' | 'chat'

interface ProviderOption {
  id: string
  label: string
  models: string[]
}

export interface AgentMentionInfo {
  id: string
  displayName: string
  description?: string
}

interface ComposerProps {
  prompt: string
  onChange: (v: string) => void
  onSend: () => void
  onStop: () => void
  running: boolean
  stopping?: boolean
  /** Another conversation's run is active — sending is temporarily blocked. */
  sendBlocked?: boolean
  sendBlockedHint?: string
  disabled: boolean
  attachments: Attachment[]
  onAttachFiles: () => void
  onAttachFilesPath: (relPath: string) => void
  /** Attach one or more absolute paths (e.g. files dropped from the OS file explorer). */
  onAttachFilesPaths: (paths: string[]) => void
  /** #4 paste image(s) from the clipboard into the composer. */
  onPasteImages: (images: { dataUrl: string; mediaType: string; name: string }[]) => void
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
  /** #20 custom agents (.agents/ + bundled) offered by the @-mention menu. */
  agentMentions: AgentMentionInfo[]
  /** #20 picking an @agent mention selects it as the run's root agent. */
  onAgentMentionPick?: (agentId: string) => void
  /** #17 per-run step cap (0 = SDK default). */
  maxAgentSteps: number
  onMaxAgentStepsChange: (steps: number) => void
  /** #17 SDK cost mode flag. */
  costMode: 'normal' | 'max' | 'lite'
  onCostModeChange: (mode: 'normal' | 'max' | 'lite') => void
  /** Increment to programmatically focus the textarea (e.g. after Revert restores a message). */
  focusSignal?: number
  /** Open the /review scope picker (#5 第二批). */
  onReviewRequest: () => void
  /** Arm interview mode — the next sent message is wrapped in the interview prompt. */
  onArmInterview: () => void
  /** Disarm interview mode without sending. */
  onDisarmInterview: () => void
  /** Whether interview mode is currently armed (drives the chip indicator). */
  interviewArmed?: boolean
}

import { getReasoningOptionsForModel } from '../utils/reasoning'

const SLASH_COMMANDS: { id: string; label: string; description: string }[] = [
  { id: 'review', label: 'review', description: 'Structured code review with scope presets' },
  { id: 'interview', label: 'interview', description: 'Interrogate your request into a detailed spec' }
]

type Mention =
  | { kind: 'file'; query: string }
  | { kind: 'agent'; query: string }
  | { kind: 'skill'; query: string }
  | null

/** Slash-step presets offered for the #17 maxAgentSteps quick control. */
const MAX_STEPS_OPTIONS = [0, 20, 40, 60, 100, 200]

const COST_MODE_OPTIONS: { value: 'normal' | 'max' | 'lite'; label: string }[] = [
  { value: 'normal', label: 'Cost: Normal' },
  { value: 'max', label: 'Cost: Max' },
  { value: 'lite', label: 'Cost: Lite' }
]

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
    running,
    stopping,
    sendBlocked,
    sendBlockedHint,
    disabled,
    attachments,
    onAttachFiles,
    onAttachFilesPath,
    onAttachFilesPaths,
    onPasteImages,
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
    agentMentions,
    onAgentMentionPick,
    maxAgentSteps,
    onMaxAgentStepsChange,
    costMode,
    onCostModeChange,
    focusSignal,
    onReviewRequest,
    onArmInterview,
    onDisarmInterview,
    interviewArmed
  } = props

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const menuItemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [mention, setMention] = useState<Mention>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  /** #9: the draft is a bash command (first non-space char is `!`). */
  const isBashMode = prompt.trimStart().startsWith('!')
  /** True while the user is dragging files over the composer (drop overlay). */
  const [dragOver, setDragOver] = useState(false)
  const dragDepthRef = useRef(0)
  /** Safety net: dragover fires at least every ~350ms, so a 1s silence means
   *  the drag left or was cancelled (ESC) even if enter/leave events got
   *  unbalanced (e.g. the overlay mounting mid-drag). */
  const dragSilenceTimerRef = useRef<number | null>(null)
  const clearDragTimer = useCallback(() => {
    if (dragSilenceTimerRef.current !== null) {
      window.clearTimeout(dragSilenceTimerRef.current)
      dragSilenceTimerRef.current = null
    }
  }, [])
  const armDragTimer = useCallback(() => {
    clearDragTimer()
    dragSilenceTimerRef.current = window.setTimeout(() => {
      dragDepthRef.current = 0
      setDragOver(false)
    }, 1000)
  }, [clearDragTimer])

  useEffect(() => () => clearDragTimer(), [clearDragTimer])

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

  // Detect the @file / @agent or /skill token being typed before the caret.
  // The @-query may contain dots, dashes, slashes and spaces inside paths —
  // but a trailing space (or the caret sitting after one) ends the token.
  const detectMention = (value: string, caret: number): Mention => {
    const before = value.slice(0, caret)
    const wordMatch = before.match(/(@[\w./\\\- ]*|\/[\w:./\\-]*)$/)
    if (!wordMatch) return null
    const token = wordMatch[1]
    if (token.startsWith('@')) {
      const query = token.slice(1).toLowerCase()
      // #20 @agent: leading '@' and the query looks like an id (no path
      // separators, no dots with extensions) — otherwise it's a file path.
      // '@agent ' (trailing space) keeps working as a file ref.
      if (!query.includes('/') && !query.includes('\\') && !query.includes('.') && !query.includes(' ')) {
        return { kind: 'agent', query }
      }
      return { kind: 'file', query }
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
    const tokenMatch = before.match(/(@[\w./\\\- ]*|\/[\w:./\\-]*)$/)
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

  const filteredFiles = mention?.kind === 'file' ? fileCandidates.filter((f) => f.toLowerCase().includes(mention.query.trim())) : []
  const filteredAgents =
    mention?.kind === 'agent'
      ? props.agentMentions.filter((a) => a.id.toLowerCase().includes(mention.query) || a.displayName.toLowerCase().includes(mention.query))
      : []
  // Built-in slash commands come FIRST so they always sit at the top of the
  // menu regardless of how many skills match (they only ever match on prefix/
  // substring of their short ids). The full list is shown — the menu scrolls.
  const filteredSkills =
    mention?.kind === 'skill'
      ? [...SLASH_COMMANDS.filter((c) => c.id.includes(mention.query)), ...skills.filter((s) => s.name.toLowerCase().includes(mention.query))]
      : []
  const mentionList = mention?.kind === 'file' ? filteredFiles : mention?.kind === 'agent' ? filteredAgents : filteredSkills

  const selectFile = (relPath: string) => {
    replaceToken(`@${relPath} `)
    // Also add as an attachment (content read on send)
    if (!attachments.some((a) => a.path === relPath)) {
      props.onAttachFilesPath(relPath)
    }
  }

  /** #20: pick a custom agent — inserts @agentId and selects it for the run. */
  const selectAgentMention = (agent: AgentMentionInfo) => {
    replaceToken(`@${agent.id} `)
    onAgentMentionPick?.(agent.id)
  }

  const selectSkill = (skill: SkillInfo | { id: string }) => {
    if ('id' in skill && !('path' in skill)) {
      // Built-in command
      replaceToken('')
      // #5 第二批：/review opens the scope picker; /interview arms the wrapper.
      if (skill.id === 'review') onReviewRequest()
      else if (skill.id === 'interview') onArmInterview()
      return
    }
    replaceToken(`/skill:${(skill as SkillInfo).name} `)
  }

  /** Resolve dropped File objects to absolute paths via the preload bridge
   *  (Electron ≥32 removed `File.path` from the renderer). */
  const droppedPaths = useCallback(async (files: FileList | null): Promise<string[]> => {
    if (!files || files.length === 0) return []
    const out: string[] = []
    for (const file of Array.from(files)) {
      try {
        // Browser preview mode has no preload bridge — fall back to the file name.
        const path = window.AnyBuff?.getPathForFile ? window.AnyBuff.getPathForFile(file) : file.name
        if (path) out.push(path)
      } catch {
        // Some dragged items (e.g. text snippets) have no backing file — skip them.
      }
    }
    return out
  }, [])

  // Drag & drop to attach files. The wrap element tracks a depth counter so
  // dragleave on a child never dismisses the overlay while a drop is still in
  // progress; the overlay itself swallows the dragover so the OS doesn't
  // navigate the window away on drop.
  const onDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      if (running) return
      dragDepthRef.current += 1
      setDragOver(true)
      armDragTimer()
    },
    [running, armDragTimer]
  )

  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      // Always accept the dragover so the OS never navigates the window on
      // drop — even while a run is in flight (where we ignore the files).
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      if (running) return
      // Fires continuously while hovering — keep the overlay (and its safety
      // timer) alive for as long as the drag is over the composer.
      armDragTimer()
    },
    [running, armDragTimer]
  )

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.types.includes('Files')) return
    e.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragOver(false)
  }, [])

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      dragDepthRef.current = 0
      clearDragTimer()
      setDragOver(false)
      if (running) return
      const paths = await droppedPaths(e.dataTransfer.files)
      if (paths.length > 0) onAttachFilesPaths(paths)
    },
    [running, droppedPaths, onAttachFilesPaths, clearDragTimer]
  )

  const modelLabel = useMemo(() => {
    const [pid, ...rest] = activeModel.split('/')
    const provider = providers.find((p) => p.id === pid)
    return provider ? `${provider.label} · ${rest.join('/') || pid}` : activeModel || 'Select model'
  }, [activeModel, providers])

  /** #20 Tab: when the caret sits right after a token with a single (or the
   *  first) file/agent match, complete it inline instead of inserting spaces. */
  const handleTabCompletion = (): boolean => {
    const el = textareaRef.current
    if (!el || !mention || mentionList.length === 0) return false
    const first = mentionList[0]
    if (mention.kind === 'file') {
      selectFile(first as string)
      return true
    }
    if (mention.kind === 'agent') {
      selectAgentMention(first as AgentMentionInfo)
      return true
    }
    return false
  }

  /** #4: paste image(s) from the clipboard straight into the composer. */
  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (running) return
      const items = Array.from(e.clipboardData?.items ?? [])
      const images = items
        .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
        .map((it) => it.getAsFile())
        .filter((f): f is File => Boolean(f))
      if (images.length === 0) return
      e.preventDefault()
      const processed = images.map((file, i) => ({
        dataUrlPromise: new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = () => reject(reader.error)
          reader.readAsDataURL(file)
        }),
        mediaType: file.type,
        name: file.name || `clipboard-${Date.now()}-${i}.png`
      }))
      void Promise.all(
        processed.map((p) =>
          p.dataUrlPromise
            .then((dataUrl) => ({ dataUrl, mediaType: p.mediaType, name: p.name }))
            .catch(() => null)
        )
      ).then((results) => {
        const ok = results.filter((r): r is { dataUrl: string; mediaType: string; name: string } => r !== null)
        if (ok.length > 0) onPasteImages(ok)
      })
    },
    [running, onPasteImages]
  )

  return (
    <div
      className="composer-wrap"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragOver && !running && (
        <div className="drop-overlay" onDragEnter={(e) => e.preventDefault()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => e.preventDefault()}>
          <PaperclipIcon size={22} />
          <span>Drop files to attach</span>
        </div>
      )}
      {interviewArmed && (
        <div className="interview-chip">
          <SparklesIcon size={12} />
          <span>
            Interview mode armed — your next message will be interrogated into a spec (no code changes)
          </span>
          <button className="chip-x" onClick={onDisarmInterview} title="Cancel interview mode">
            <XIcon size={10} />
          </button>
        </div>
      )}
      {isBashMode && (
        <div className="bash-mode-chip">
          <span className="bash-mode-cmd">$ {prompt.trimStart().slice(1).trim()}</span>
          <span className="bash-mode-hint">Bash mode — Enter runs this locally; the output becomes context for your next message (Esc won't cancel the run)</span>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="attachment-strip">
          {attachments.map((att) => (
            <span key={att.path} className={`attachment-chip${att.isImage ? ' image-chip' : ''}`}>
              {att.isImage && att.previewUrl ? (
                <img className="attachment-thumb" src={att.previewUrl} alt={att.name} />
              ) : (
                <span aria-hidden="true">{att.isDir ? '📁' : '📄'}</span>
              )}
              <span className="attachment-name" title={att.path}>{att.name}</span>
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
          onPaste={onPaste}
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
                if (e.key === 'Tab') {
                  // #20 Tab completion: accept the highlighted/first match.
                  e.preventDefault()
                  if (mention.kind === 'file') selectFile(list[mentionIndex] as string)
                  else if (mention.kind === 'agent') selectAgentMention(list[mentionIndex] as AgentMentionInfo)
                  return
                }
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const item = list[mentionIndex]
                  if (mention.kind === 'file') selectFile(item as string)
                  else if (mention.kind === 'agent') selectAgentMention(item as AgentMentionInfo)
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
            if (e.key === 'Tab' && handleTabCompletion()) {
              e.preventDefault()
              return
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              // While a run is in flight App.tsx routes this into the message
              // queue instead of rejecting it (#2 執行中訊息佇列).
              if (!disabled) onSend()
            }
          }}
          onClick={() => setMention(detectMention(prompt, textareaRef.current?.selectionStart ?? prompt.length))}
          placeholder="Type a message — ! for bash, / for skills, @ for files & agents"
          rows={1}
          disabled={disabled}
        />

        {mention && (
          <div className="mention-menu">
            {mention.kind === 'file' &&
              (filteredFiles.length === 0 ? (
                <div className="mention-empty">No matching files</div>
              ) : (
                filteredFiles.map((f, i) => (
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

            {mention.kind === 'agent' &&
              (filteredAgents.length === 0 ? (
                <div className="mention-empty">No matching agents — files are shown for path-like queries</div>
              ) : (
                filteredAgents.map((a, i) => (
                  <button
                    key={a.id}
                    ref={(el) => {
                      menuItemRefs.current[i] = el
                    }}
                    className={`mention-item ${i === mentionIndex ? 'selected' : ''}`}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      selectAgentMention(a)
                    }}
                    onMouseEnter={() => setMentionIndex(i)}
                  >
                    <span className="mention-icon">🤖</span>
                    <span className="mention-text">@{a.id}</span>
                    {a.displayName !== a.id && <span className="mention-desc">{a.displayName}</span>}
                    {a.description && <span className="mention-desc">{a.description}</span>}
                  </button>
                ))
              ))}

            {mention.kind === 'skill' &&
              (filteredSkills.length === 0 ? (
                <div className="mention-empty">No matching skills</div>
              ) : (
                filteredSkills.map((item, i) => (
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
              <StopIcon size={18} />
            </button>
          </>
        ) : (
          <button
            className="btn primary send-btn"
            onClick={onSend}
            disabled={disabled || !prompt.trim()}
            title={
              isBashMode
                ? 'Run command locally and attach output as context (Enter)'
                : sendBlocked
                  ? 'Another task is running — this will be queued'
                  : 'Send (Enter)'
            }
          >
            {isBashMode ? <span className="bash-send-glyph">$</span> : <ArrowUpIcon size={16} />}
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
            className="mode-select"
            options={[
              { value: 'chat', label: 'Chat', icon: <ChatIcon size={13} /> },
              { value: 'default', label: 'Build', icon: <HammerIcon size={13} /> },
              { value: 'plan', label: 'Plan', icon: <ListIcon size={13} /> }
            ]}
            title="Agent mode — Chat answers questions without touching your files"
          />

          <CustomSelect
            icon={<SparklesIcon size={13} />}
            value={activeModel}
            onChange={onModelChange}
            disabled={running}
            size="small"
            placement="top"
            className="model-select"
            placeholder={providers.length === 0 ? 'No provider configured' : 'Select model'}
            options={providers.flatMap((p) =>
              p.models.map((m) => ({
                value: `${p.id}/${m}`,
                label: `${p.label} / ${m}`
              }))
            )}
            title={providers.length === 0 ? 'No provider configured' : `Model: ${modelLabel}`}
          />

          <CustomSelect
            icon={<LightbulbIcon size={13} />}
            value={reasoningEffort}
            onChange={onReasoningChange}
            disabled={running}
            size="small"
            placement="top"
            className="reasoning-select"
            options={getReasoningOptionsForModel(activeModel).map((r) => ({
              value: r,
              label: r === 'default' ? 'Default' : r.charAt(0).toUpperCase() + r.slice(1).replace('-', ' ')
            }))}
            title="Reasoning level"
          />

          {/* #17 保險絲：per-run step cap (0 = SDK default 200) — stops a
              runaway agent loop from burning tokens unattended. */}
          <CustomSelect
            value={String(maxAgentSteps)}
            onChange={(v) => onMaxAgentStepsChange(Number(v))}
            disabled={running}
            size="small"
            placement="top"
            className="steps-select"
            options={MAX_STEPS_OPTIONS.map((n) => ({
              value: String(n),
              label: n === 0 ? 'Steps: ∞' : `Steps: ≤ ${n}`
            }))}
            title="Max agent steps per run (0 = default cap of 200)"
          />

          <CustomSelect
            value={costMode}
            onChange={(v) => onCostModeChange(v as 'normal' | 'max' | 'lite')}
            disabled={running}
            size="small"
            placement="top"
            className="costmode-select"
            options={COST_MODE_OPTIONS}
            title="Cost mode flag forwarded to the model run"
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
