import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
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
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[anybuff] renderer crashed while rendering the chat view:', error, info)
  }

  private handleRetry = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="error-boundary" role="alert">
          <span className="error-boundary-icon">⚠️</span>
          <div className="error-boundary-title">This conversation could not be displayed</div>
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
