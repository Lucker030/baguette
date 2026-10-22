import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  /** Short name of what this boundary wraps, for the fallback and the log. */
  label: string
  children: ReactNode
  /** Fill the whole area rather than a compact inline card. */
  fullscreen?: boolean
}

interface State {
  error: Error | null
}

/**
 * Catches a render error in one screen so it cannot blank the whole app.
 *
 * Without this, a thrown render anywhere — a library panel, one terminal's
 * chrome — unmounts the entire React tree, terminals included, and the window
 * goes empty with no explanation. Each screen gets its own boundary, so a
 * broken 知識庫 still leaves every terminal running and visible, and the
 * failure is written to the main-process log where it can be found later.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    try {
      window.api.log(
        'error',
        `ErrorBoundary(${this.props.label}): ${error.stack ?? error.message}${
          info.componentStack ? ` | component stack:${info.componentStack.replace(/\s*\n\s*/g, ' > ')}` : ''
        }`
      )
    } catch {
      /* the bridge itself is gone; nothing more to do */
    }
  }

  private reset = (): void => this.setState({ error: null })

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    const card = (
      <div className="max-w-lg rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm">
        <div className="font-medium text-red-300">「{this.props.label}」畫面出錯了</div>
        <div className="mt-1 break-all font-mono text-xs text-red-200/80">{error.message}</div>
        <div className="mt-2 text-xs text-txt-dim">
          其他部分不受影響，詳細錯誤已寫進 log（設定 → 資料與 log）。
        </div>
        <div className="mt-3 flex gap-2">
          <button
            onClick={this.reset}
            className="rounded-md border border-line px-3 py-1 text-xs text-txt-dim hover:bg-bg-hover hover:text-txt-base"
          >
            重試
          </button>
          {this.props.fullscreen && (
            <button
              onClick={() => window.location.reload()}
              className="rounded-md border border-line px-3 py-1 text-xs text-txt-dim hover:bg-bg-hover hover:text-txt-base"
            >
              重新載入介面（session 會保留）
            </button>
          )}
        </div>
      </div>
    )

    return this.props.fullscreen ? (
      <div className="flex h-full w-full items-center justify-center bg-bg-base p-6">{card}</div>
    ) : (
      <div className="flex h-full w-full items-start justify-center p-6">{card}</div>
    )
  }
}
