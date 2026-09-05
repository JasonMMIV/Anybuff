import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Override the fallback card's title (defaults to the chat-list copy). */
  title?: string
}

interface State {
  error: Error | null
}

/**
 * Render-level error boundary.
 *
 * A malformed or legacy persisted transcript item (or any other render crash)
 * used to white-screen the whole app, because React unmounts the tree on an
 * uncaught render error. Scoping a boundary around the chat list keeps the
 * sidebar, composer and settings usable, and offers recovery actions instead.
 * A second boundary wraps the whole app (main.tsx) so an uncaught render error
 * ANYWHERE shows a recoverable card rather than a dead white screen — the
 * Android WebView symptom this project hit.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  private static defaultTitle = 'This conversation could not be displayed'

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[anybuff] renderer crashed while rendering the chat view:', error, info)
  }

  private handleRetry = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    if (this.state.error) {
      const title = this.props.title ?? ErrorBoundary.defaultTitle
      return (
        <div className="error-boundary" role="alert">
          <span className="error-boundary-icon">⚠️</span>
          <div className="error-boundary-title">{title}</div>
          <div className="error-boundary-message">
            {String(this.state.error.message || this.state.error)}
          </div>
          <div className="error-boundary-actions">
            <button className="btn" onClick={this.handleRetry}>Try again</button>
            <button className="btn" onClick={() => window.location.reload()}>Reload app</button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
