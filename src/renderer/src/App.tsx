import { useEffect } from 'react'
import { useApp } from './store/sessions'
import { PROVIDER_UI } from './providerUi'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { TerminalView } from './components/TerminalView'
import { SkillsLibrary } from './components/SkillsLibrary'
import { SettingsPanel } from './components/SettingsPanel'
import { HooksLibrary } from './components/HooksLibrary'
import { DevicesPanel } from './components/DevicesPanel'
import { KnowledgeLibrary } from './components/KnowledgeLibrary'
import { EmptyState } from './components/EmptyState'
import { ToastStack } from './components/ToastStack'
import { ErrorBoundary } from './components/ErrorBoundary'
import { matchShortcut } from './shortcuts'
import { TERMINAL_FONT_SIZE_DEFAULT } from '@shared/types'

/** Absolute rect for pane `i` of `n`, as CSS percentages. */
function paneRect(
  i: number,
  n: number,
  direction: 'row' | 'col'
): { left: string; top: string; width: string; height: string } {
  const size = 100 / n
  return direction === 'row'
    ? { left: `${i * size}%`, top: '0%', width: `${size}%`, height: '100%' }
    : { left: '0%', top: `${i * size}%`, width: '100%', height: `${size}%` }
}

export default function App(): JSX.Element {
  const {
    init,
    sessions,
    activeId,
    view,
    loginUrls,
    dismissLoginUrl,
    pushToast,
    panes,
    focusedPane,
    splitDirection,
    focusPane,
    closePane,
    sessionName,
    clearAttention,
    restartSession
  } = useApp()

  // Which pane (if any) each session is rendered into. Sessions not on screen
  // stay mounted but hidden, so their scrollback survives being swapped out.
  const paneOf = new Map<string, number>()
  panes.forEach((sid, i) => {
    if (sid) paneOf.set(sid, i)
  })
  const split = panes.length > 1

  useEffect(() => {
    void init()
  }, [init])

  // Renderer-side IPC calls (window.api.*) mostly fire-and-forget from button
  // handlers with no local try/catch; without this, a rejected call fails
  // silently and the button just looks like it did nothing.
  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent): void => {
      const reason = e.reason as { message?: string; stack?: string } | string | undefined
      const message =
        (typeof reason === 'string' ? reason : reason?.message) || '發生未預期的錯誤，請再試一次。'
      pushToast(message)
      window.api.log('error', `unhandledrejection: ${typeof reason === 'string' ? reason : reason?.stack ?? message}`)
    }
    const onError = (e: ErrorEvent): void => {
      window.api.log('error', `window.onerror: ${e.error?.stack ?? e.message}`)
    }
    window.addEventListener('unhandledrejection', onRejection)
    window.addEventListener('error', onError)
    return () => {
      window.removeEventListener('unhandledrejection', onRejection)
      window.removeEventListener('error', onError)
    }
  }, [pushToast])

  // Coming back to the window means the active tab has been seen.
  useEffect(() => {
    const onFocus = (): void => {
      const s = useApp.getState()
      if (s.view === 'terminal' && s.activeId) clearAttention(s.activeId)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [clearAttention])

  // App-wide shortcuts (see shortcuts.ts for the table). Registered in the
  // capture phase on window so they win over xterm's own keydown handling —
  // stopping propagation here means the terminal's textarea never sees the
  // key, so Ctrl+Tab cannot also type a tab into the CLI. Copy is the one
  // exception: only TerminalView can read the selection, so it handles that
  // itself and we let it through.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const hit = matchShortcut(e)
      if (!hit || hit.id === 'copy') return
      const s = useApp.getState()
      // Search only makes sense over a terminal; leave other inputs alone.
      if (hit.id === 'search' && s.view !== 'terminal') return
      e.preventDefault()
      e.stopPropagation()
      switch (hit.id) {
        case 'newSession':
          void s.newSession('claude')
          break
        case 'closeSession':
          s.closeActiveSession()
          break
        case 'nextSession':
          s.activateRelative(1)
          break
        case 'prevSession':
          s.activateRelative(-1)
          break
        case 'nthSession':
          if (hit.n) s.activateNth(hit.n)
          break
        case 'split':
          s.splitPane()
          break
        case 'search':
          s.requestSearch()
          break
        case 'zoomIn':
          void s.setTerminalFontSize(s.terminalFontSize + 1)
          break
        case 'zoomOut':
          void s.setTerminalFontSize(s.terminalFontSize - 1)
          break
        case 'zoomReset':
          void s.setTerminalFontSize(TERMINAL_FONT_SIZE_DEFAULT)
          break
        case 'settings':
          s.setView('settings')
          break
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  // A file dropped anywhere except a terminal would otherwise make the window
  // navigate to it, replacing the app with the file's contents and losing
  // every open tab. Terminals call preventDefault themselves and handle it.
  useEffect(() => {
    const swallow = (e: DragEvent): void => e.preventDefault()
    window.addEventListener('dragover', swallow)
    window.addEventListener('drop', swallow)
    return () => {
      window.removeEventListener('dragover', swallow)
      window.removeEventListener('drop', swallow)
    }
  }, [])

  return (
    <ErrorBoundary label="baguette" fullscreen>
    <div className="flex h-full w-full bg-bg-base text-txt-base">
      <ErrorBoundary label="側欄">
        <Sidebar />
      </ErrorBoundary>
      <div className="flex min-w-0 flex-1 flex-col">
        <ErrorBoundary label="工具列">
          <TopBar />
        </ErrorBoundary>
        <div className="relative min-h-0 flex-1">
          {/* Terminals stay mounted to preserve scrollback; panes only decide
              where each one sits, so splitting never restarts a session. */}
          {sessions.map((s) => {
            const loginUrl = loginUrls[s.id]
            const pane = paneOf.get(s.id)
            const visible = view === 'terminal' && pane !== undefined
            const rect = visible ? paneRect(pane, panes.length, splitDirection) : null
            const isFocusedPane = pane === focusedPane
            return (
              <div
                key={s.id}
                onMouseDownCapture={() => pane !== undefined && focusPane(pane)}
                className={`absolute flex flex-col ${
                  split ? (isFocusedPane ? 'ring-1 ring-copilot/50' : 'ring-1 ring-line') : ''
                }`}
                style={{
                  display: visible ? 'flex' : 'none',
                  ...(rect ?? { left: 0, top: 0, width: '100%', height: '100%' })
                }}
              >
                {split && (
                  <div className="flex items-center gap-2 border-b border-line bg-bg-panel px-2 py-1 text-[11px]">
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ background: PROVIDER_UI[s.provider].color }}
                    />
                    {/* The tab's name, not its cwd: split panes usually share a
                        cwd, so the path can't tell them apart. */}
                    <span className="truncate text-txt-base" title={s.cwd}>
                      {sessionName[s.id] ?? PROVIDER_UI[s.provider].label}
                    </span>
                    <button
                      onClick={() => pane !== undefined && closePane(pane)}
                      title="關閉這個分割（session 會繼續執行）"
                      className="ml-auto shrink-0 rounded px-1.5 text-txt-dim hover:bg-bg-hover hover:text-txt-base"
                    >
                      ✕
                    </button>
                  </div>
                )}
                {s.authState === 'needsLogin' && s.status === 'running' && (
                  <div className="flex flex-wrap items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
                    <span className="text-amber-200">
                      這個分頁的登入已失效。在任何一個分頁完成 /login 後，這裡會自動用原本的對話重啟，不用每個分頁各登一次。
                    </span>
                    <button
                      onClick={() => window.api.writeSession(s.id, '/login\r')}
                      className="rounded border border-amber-500/50 px-2 py-1 text-amber-100 hover:bg-amber-500/20"
                    >
                      在這裡登入
                    </button>
                    <button
                      onClick={() => void restartSession(s.id)}
                      title="已經在別的分頁登入過了？直接用新憑證重啟這個分頁"
                      className="rounded border border-line px-2 py-1 text-txt-dim hover:bg-bg-base hover:text-txt-base"
                    >
                      現在重啟
                    </button>
                  </div>
                )}
                {loginUrl && (
                  <div className="flex items-center gap-2 border-b border-copilot/40 bg-bg-hover px-3 py-2 text-xs">
                    <span className="text-txt-base">已偵測到登入連結，瀏覽器應已自動開啟。</span>
                    <button
                      onClick={() => window.open(loginUrl, '_blank')}
                      className="rounded border border-line px-2 py-1 text-txt-dim hover:bg-bg-base hover:text-txt-base"
                    >
                      重新開啟
                    </button>
                    <button
                      onClick={() => void navigator.clipboard.writeText(loginUrl)}
                      className="rounded border border-line px-2 py-1 text-txt-dim hover:bg-bg-base hover:text-txt-base"
                    >
                      複製連結
                    </button>
                    <button
                      onClick={() => dismissLoginUrl(s.id)}
                      className="ml-auto rounded px-2 py-1 text-txt-dim hover:bg-bg-base hover:text-txt-base"
                    >
                      ✕
                    </button>
                  </div>
                )}
                {s.status === 'error' ? (
                  <div className="flex min-h-0 flex-1 items-center justify-center p-6">
                    <div className="max-w-md rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                      {s.message ?? '啟動失敗'}
                    </div>
                  </div>
                ) : (
                  <div className="min-h-0 flex-1">
                    <ErrorBoundary label={sessionName[s.id] ?? PROVIDER_UI[s.provider].label}>
                      <TerminalView id={s.id} active={visible && s.id === activeId} />
                    </ErrorBoundary>
                  </div>
                )}
              </div>
            )
          })}

          {/* Placeholder for a pane that was opened but has no session yet. */}
          {view === 'terminal' &&
            panes.map((sid, i) =>
              sid ? null : (
                <div
                  key={`empty-${i}`}
                  onMouseDownCapture={() => focusPane(i)}
                  className={`absolute flex flex-col items-center justify-center gap-2 bg-bg-base text-xs text-txt-dim ${
                    i === focusedPane ? 'ring-1 ring-copilot/50' : 'ring-1 ring-line'
                  }`}
                  style={paneRect(i, panes.length, splitDirection)}
                >
                  <span>從左側點一個 session 放進這一格</span>
                  <button
                    onClick={() => closePane(i)}
                    className="rounded border border-line px-2 py-1 hover:bg-bg-hover hover:text-txt-base"
                  >
                    關閉這一格
                  </button>
                </div>
              )
            )}

          {view === 'terminal' && sessions.length === 0 && <EmptyState />}

          {/* Each library screen sits in its own boundary so a crash in one
              leaves the terminals — and the way back to them — untouched. */}
          {view === 'skills' && (
            <div className="absolute inset-0 bg-bg-base">
              <ErrorBoundary label="Skills 庫">
                <SkillsLibrary />
              </ErrorBoundary>
            </div>
          )}

          {view === 'settings' && (
            <div className="absolute inset-0 bg-bg-base">
              <ErrorBoundary label="設定">
                <SettingsPanel />
              </ErrorBoundary>
            </div>
          )}

          {view === 'devices' && (
            <div className="absolute inset-0 bg-bg-base">
              <ErrorBoundary label="內網裝置">
                <DevicesPanel />
              </ErrorBoundary>
            </div>
          )}

          {view === 'knowledge' && (
            <div className="absolute inset-0 bg-bg-base">
              <ErrorBoundary label="知識庫">
                <KnowledgeLibrary />
              </ErrorBoundary>
            </div>
          )}

          {view === 'hooks' && (
            <div className="absolute inset-0 bg-bg-base">
              <ErrorBoundary label="Hook 庫">
                <HooksLibrary />
              </ErrorBoundary>
            </div>
          )}

          <ToastStack />
        </div>
      </div>
    </div>
    </ErrorBoundary>
  )
}
