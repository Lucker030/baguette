import { useApp } from '../../store/sessions'

type View = ReturnType<typeof useApp.getState>['view']

interface NavItem {
  view: View
  label: string
}

/**
 * The "Add-ons" nav block plus the settings row. Purely a view switcher —
 * adding a library screen is one entry in `ITEMS` rather than another
 * copy-pasted button.
 *
 * This list is expected to grow, so it gets its own capped scroll region:
 * without one, more entries would squeeze the session list above it down to
 * nothing and eventually push 設定 off the bottom of the sidebar.
 */
const ITEMS: NavItem[] = [
  { view: 'todos', label: '代辦事項' },
  { view: 'knowledge', label: '知識庫' },
  { view: 'hooks', label: 'Hook 庫' },
  { view: 'skills', label: 'Skills 庫' }
]

export function AddonNav({ currentAccount }: { currentAccount: string }): JSX.Element {
  const { view, setView } = useApp()
  const updateAvailable = useApp((s) => s.update?.latestVersion ?? null)

  const rowClass = (active: boolean): string =>
    `flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors ${
      active ? 'bg-bg-hover text-txt-base' : 'text-txt-dim hover:bg-bg-elev'
    }`

  return (
    <>
      <div className="flex min-h-0 shrink-0 flex-col" style={{ maxHeight: '45%' }}>
        <div className="shrink-0 border-t border-line px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-txt-dim">
          Add-ons
        </div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
          {ITEMS.map((item) => (
            <button
              key={item.view}
              onClick={() => setView(item.view)}
              className={rowClass(view === item.view)}
            >
              <span className="flex-1 truncate">{item.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Pinned: 設定 must stay reachable no matter how long the list gets.
          Shows the current Claude account as a badge, since account
          management now lives inside 設定 rather than its own nav entry. */}
      <div className="shrink-0 border-t border-line px-2 py-2">
        <button
          onClick={() => setView('settings')}
          className={rowClass(view === 'settings')}
          title="設定"
        >
          <span className="flex-1 truncate text-left">設定</span>
          {updateAvailable && (
            <span
              className="shrink-0 rounded bg-copilot/20 px-1.5 text-[10px] font-medium text-copilot"
              title={`有新版本 ${updateAvailable}`}
            >
              新版本
            </span>
          )}
          <span className="max-w-[88px] shrink-0 truncate text-[11px] text-txt-dim" title={currentAccount}>
            {currentAccount}
          </span>
        </button>
      </div>
    </>
  )
}
