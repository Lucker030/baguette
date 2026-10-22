import { useApp } from '../store/sessions'
import { PROVIDER_UI } from '../providerUi'
import { ProviderSwitch } from './ProviderSwitch'

export function TopBar(): JSX.Element {
  const {
    sessions,
    activeId,
    view,
    nextCwd,
    pickNextCwd,
    panes,
    splitDirection,
    splitPane,
    toggleSplitDirection
  } = useApp()
  const active = sessions.find((s) => s.id === activeId)
  const canSplit = view === 'terminal' && panes.length > 0

  return (
    <header className="flex items-center justify-between gap-4 border-b border-line bg-bg-panel px-4 py-2">
      <div className="flex min-w-0 items-center gap-3">
        {view === 'skills' ? (
          <span className="text-sm font-medium">Skills 庫</span>
        ) : active ? (
          <>
            <span
              className="rounded px-2 py-0.5 text-xs font-semibold"
              style={{ background: `${PROVIDER_UI[active.provider].color}22`, color: PROVIDER_UI[active.provider].color }}
            >
              {PROVIDER_UI[active.provider].label}
            </span>
            <span className="truncate text-xs text-txt-dim" title={active.cwd}>
              {active.cwd}
            </span>
            <StatusDot status={active.status} />
          </>
        ) : (
          <span className="text-sm text-txt-dim">DashBoard</span>
        )}
      </div>

      <div className="flex items-center gap-2">
        {canSplit && (
          <div className="flex items-center rounded-lg border border-line bg-bg-panel">
            <button
              onClick={splitPane}
              title="分割畫面：同時顯示另一個 session"
              className="rounded-l-lg px-2 py-1 text-xs text-txt-dim hover:bg-bg-hover hover:text-txt-base"
            >
              ⊞ 分割
            </button>
            {panes.length > 1 && (
              <button
                onClick={toggleSplitDirection}
                title={splitDirection === 'row' ? '改成上下排列' : '改成左右排列'}
                className="rounded-r-lg border-l border-line px-2 py-1 text-xs text-txt-dim hover:bg-bg-hover hover:text-txt-base"
              >
                {splitDirection === 'row' ? '⇅' : '⇄'}
              </button>
            )}
          </div>
        )}
        <button
          onClick={() => void pickNextCwd()}
          title={`新 session 的工作目錄：${nextCwd}\n點擊選擇資料夾`}
          className="flex max-w-[260px] items-center gap-1.5 rounded-lg border border-line bg-bg-panel px-2.5 py-1 text-xs text-txt-dim hover:bg-bg-hover hover:text-txt-base"
        >
          <span className="shrink-0 text-txt-dim">目錄</span>
          <span className="truncate">{nextCwd || '（預設目錄）'}</span>
        </button>
        <ProviderSwitch />
      </div>
    </header>
  )
}

function StatusDot({ status }: { status: string }): JSX.Element {
  const map: Record<string, [string, string]> = {
    running: ['#3fb950', '執行中'],
    starting: ['#d29922', '啟動中'],
    exited: ['#7d8590', '已結束'],
    error: ['#f85149', '錯誤']
  }
  const [color, label] = map[status] ?? ['#7d8590', status]
  return (
    <span className="flex items-center gap-1 text-xs text-txt-dim">
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  )
}
