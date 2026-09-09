import { useEffect, useRef, useState } from 'react'
import hljs from 'highlight.js'
import type { JSX } from 'react'
import { AlertCircleIcon, FileIcon, XIcon } from './Icons'
import { renderMarkdown } from '../utils/markdown'

export interface PreviewFile {
  path: string
  name: string
}

interface Props {
  file: PreviewFile | null
  onClose: () => void
}

/** Result shape of the AnyBuff:readFileData channel (see host-core handlers-files). */
interface ReadDataResult {
  ok: boolean
  error?: string
  code?: 'too-large' | 'binary' | 'missing' | 'not-a-file'
  size?: number
  kind?: 'text' | 'image'
  mime?: string
  text?: string
  base64?: string
}

const MARKDOWN_RE = /\.(md|markdown|mdx|mdown|mkd)$/i
/** Rendering caps: past these, markdown/highlighting is skipped for a plain view. */
const MAX_MARKDOWN_CHARS = 512 * 1024
const MAX_HIGHLIGHT_CHARS = 256 * 1024

/**
 * Gap #14 浮動檔案預覽視窗 — replaces the old right-panel inline <pre> preview.
 * Renders markdown / syntax-highlighted code / plain text and images (incl.
 * svg via data URL). Content loads through AnyBuff.readFileData so both the
 * Electron IPC and the Android WS transports behave identically.
 *
 * The view stays intentionally clean: file actions (Open folder / Open
 * externally / Download) live on the row's right-click / long-press menu, not
 * here. Only the file name, path and a close button accompany the content.
 */
export default function FilePreviewModal(props: Props) {
  const { file } = props
  if (!file) return null
  // key remount on every path switch: fresh state + scroll position per file.
  return <FilePreviewModalInner key={file.path} {...props} file={file} />
}

function FilePreviewModalInner({ file, onClose }: Props & { file: PreviewFile }) {
  const [data, setData] = useState<ReadDataResult | null>(null)
  const [loading, setLoading] = useState(true)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 })
    if (typeof window.AnyBuff === 'undefined') {
      setData({ ok: false, error: 'Preview is unavailable in demo mode' })
      setLoading(false)
      return
    }
    setLoading(true)
    setData(null)
    void (window.AnyBuff.readFileData(file.path) as Promise<ReadDataResult>)
      .then((res) => {
        setLoading(false)
        setData(res ?? { ok: false, error: 'Preview failed' })
      })
      .catch((err: unknown) => {
        setLoading(false)
        setData({ ok: false, error: err instanceof Error ? err.message : String(err) })
      })
  }, [file])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const isImage = Boolean(data?.ok && data.kind === 'image')

  let body: JSX.Element
  if (loading) {
    body = (
      <div className="preview-loading">
        <span className="preview-spinner" />
        <span>Loading preview…</span>
      </div>
    )
  } else if (!data?.ok) {
    const hint =
      data?.code === 'too-large' || data?.code === 'binary'
        ? 'The file is too large or binary for an inline preview — right-click (or long-press) the file entry for Open externally / Download options.'
        : undefined
    body = (
      <div className="preview-error">
        <div className="preview-error-title">
          <AlertCircleIcon size={16} />
          <span>Cannot preview this file</span>
        </div>
        <div>{data?.error ?? 'Could not read the file.'}</div>
        {hint && <div className="preview-error-hint">{hint}</div>}
      </div>
    )
  } else if (data.kind === 'image' && data.mime && data.base64 != null) {
    body = (
      <div className="preview-image-wrap">
        <img
          className="preview-image"
          src={`data:${data.mime};base64,${data.base64}`}
          alt={file.name}
        />
      </div>
    )
  } else if (data.kind === 'text') {
    const text = data.text ?? ''
    body = renderTextView(file.name, text)
  } else {
    body = (
      <div className="preview-error">
        <div className="preview-error-title">
          <AlertCircleIcon size={16} />
          <span>Cannot preview this file</span>
        </div>
        <div>Unsupported file content.</div>
      </div>
    )
  }

  return (
    <div className="modal-backdrop file-preview-backdrop" onClick={onClose}>
      <div
        className="file-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Preview ${file.name}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="file-preview-modal-header">
          <div className="file-preview-modal-title">
            <span className="file-preview-modal-icon">
              <FileIcon size={15} />
            </span>
            <span className="file-preview-modal-name">{file.name}</span>
            <span className="file-preview-modal-path" title={file.path}>
              {file.path}
            </span>
          </div>
          <button type="button" className="mini-btn file-preview-modal-close" onClick={onClose} title="Close preview" aria-label="Close preview">
            <XIcon size={14} />
          </button>
        </header>

        {/* image-body switches the scroll container into a fit-to-page layout
            (flex fill + max-width/max-height:100% — never upscales). */}
        <div className={`file-preview-modal-body${isImage ? ' image-body' : ''}`} ref={bodyRef}>
          {body}
        </div>
      </div>
    </div>
  )
}

/** Text body: markdown when the extension says so, else highlighted code / plain. */
function renderTextView(name: string, text: string): JSX.Element {
  if (text === '') {
    return <div className="preview-empty">Empty file</div>
  }
  if (MARKDOWN_RE.test(name) && text.length <= MAX_MARKDOWN_CHARS) {
    return (
      <div className="preview-md">
        {/* renderMarkdown already sanitizes (DOMPurify) and adds copy buttons. */}
        <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
      </div>
    )
  }
  let html = ''
  if (text.length <= MAX_HIGHLIGHT_CHARS) {
    try {
      const ext = name.split('.').pop()?.toLowerCase() ?? ''
      html = (hljs.getLanguage(ext) ? hljs.highlight(text, { language: ext }) : hljs.highlightAuto(text)).value
    } catch {
      html = ''
    }
  }
  if (html) {
    return <pre className="preview-code"><code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /></pre>
  }
  return <pre className="preview-code">{text}</pre>
}
