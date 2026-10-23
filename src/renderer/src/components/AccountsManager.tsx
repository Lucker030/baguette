import { useState } from 'react'
import { ACCOUNT_PROVIDERS, type AccountProvider } from '@shared/types'
import { useApp } from '../store/sessions'
import { PROVIDER_UI } from '../providerUi'

/** Each CLI's own default config dir — the implicit first account. */
const DEFAULT_DIR: Record<AccountProvider, string> = {
  claude: '~/.claude',
  codex: '~/.codex',
  copilot: '~/.copilot'
}

export function AccountsManager(): JSX.Element {
  const {
    settings,
    addAccount,
    renameAccount,
    removeAccount,
    setCurrentAccount,
    createSession
  } = useApp()
  const [provider, setProvider] = useState<AccountProvider>('claude')
  const [newLabel, setNewLabel] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState('')

  const accounts = (settings?.accounts ?? []).filter((a) => (a.provider ?? 'claude') === provider)
  const currentId =
    provider === 'claude' ? (settings?.currentAccountId ?? null) : (settings?.currentAccounts?.[provider] ?? null)
  const label = PROVIDER_UI[provider].label

  const add = async (): Promise<void> => {
    const name = newLabel.trim()
    if (!name) return
    await addAccount(name, provider)
    setNewLabel('')
  }

  const login = (id: string | null): void => {
    // Open a session of this CLI bound to this account. For Claude we scan
    // the early output for the login URL ourselves and open it via Electron's
    // shell.openExternal, since the CLI's own browser-launch is unreliable
    // inside this app's pty — the terminal fallback (press `c` to copy) still
    // works if detection misses it. The other CLIs run their own sign-in
    // (`/login` inside the tab) against the account's folder.
    void createSession(provider, { accountId: id ?? 'default', autoOpenLoginUrl: provider === 'claude' })
  }

  // The CLI's built-in default account is rendered as a fixed first row.
  const rows: { id: string | null; label: string; dir: string; removable: boolean }[] = [
    { id: null, label: '預設帳號', dir: DEFAULT_DIR[provider], removable: false },
    ...accounts.map((a) => ({ id: a.id, label: a.label, dir: a.configDir, removable: true }))
  ]

  return (
    <div className="space-y-3">
      <div className="flex gap-1 rounded-lg border border-line bg-bg-panel p-1 text-xs w-fit">
        {ACCOUNT_PROVIDERS.map((p) => (
          <button
            key={p}
            onClick={() => {
              setProvider(p)
              setEditingId(null)
            }}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1 ${
              p === provider ? 'bg-bg-hover text-txt-base' : 'text-txt-dim hover:text-txt-base'
            }`}
          >
            <span className="h-2 w-2 rounded-full" style={{ background: PROVIDER_UI[p].color }} />
            {PROVIDER_UI[p].label}
          </button>
        ))}
        <span
          title="agy 的登入固定存在 Windows 認證管理員的 gemini:antigravity，換資料夾分不開帳號；要換帳號請在分頁裡 /logout 再 /login"
          className="flex cursor-not-allowed items-center gap-1.5 rounded-md px-3 py-1 text-txt-dim/50"
        >
          <span className="h-2 w-2 rounded-full opacity-50" style={{ background: PROVIDER_UI.antigravity.color }} />
          Antigravity
        </span>
      </div>

      <p className="text-xs text-txt-dim">
        點圓點切換目前帳號，新開的 {label} 分頁會用它；「登入」會用該帳號開一個 {label} 分頁讓你登入。
      </p>

      <ul className="space-y-2">
        {rows.map((row) => {
          const isCurrent = (row.id ?? null) === currentId
          // The default row's id is null, and so is editingId when nothing is
          // being renamed — compare only real ids, or the default row is
          // permanently stuck showing an empty rename box.
          const isEditing = row.id !== null && editingId === row.id
          return (
            <li
              key={row.id ?? '__default__'}
              title={row.dir}
              className={`rounded-lg border px-3 py-2 ${
                isCurrent ? 'border-copilot/60 bg-bg-hover' : 'border-line bg-bg-panel'
              }`}
            >
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void setCurrentAccount(row.id, provider)}
                  title="設為目前帳號"
                  className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${
                    isCurrent ? 'border-copilot' : 'border-line'
                  }`}
                >
                  {isCurrent && <span className="h-2 w-2 rounded-full bg-copilot" />}
                </button>

                {isEditing ? (
                  <input
                    autoFocus
                    value={editLabel}
                    onChange={(e) => setEditLabel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && row.id) {
                        void renameAccount(row.id, editLabel)
                        setEditingId(null)
                      }
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                    className="flex-1 rounded border border-line bg-bg-base px-2 py-1 text-sm outline-none focus:border-copilot"
                  />
                ) : (
                  <span className="flex-1 truncate text-sm font-medium">
                    {row.label}
                    {isCurrent && <span className="ml-2 text-[11px] text-copilot">目前</span>}
                  </span>
                )}

                <button
                  onClick={() => login(row.id)}
                  title={`用這個帳號開一個 ${label} 分頁；還沒登入過的話在分頁裡完成登入`}
                  className="rounded border border-line px-2 py-1 text-xs text-txt-dim hover:bg-bg-base hover:text-txt-base"
                >
                  登入
                </button>
                {row.removable && !isEditing && (
                  <button
                    onClick={() => {
                      setEditingId(row.id)
                      setEditLabel(row.label)
                    }}
                    className="rounded border border-line px-2 py-1 text-xs text-txt-dim hover:bg-bg-base hover:text-txt-base"
                  >
                    改名
                  </button>
                )}
                {row.removable && row.id && (
                  <button
                    onClick={() => void removeAccount(row.id!)}
                    className="rounded border border-line px-2 py-1 text-xs text-red-400 hover:bg-bg-base"
                  >
                    移除
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ul>

      <div className="flex gap-2">
        <input
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
          placeholder="新帳號名稱，例如 work"
          className="flex-1 rounded-md border border-line bg-bg-base px-3 py-1.5 text-sm outline-none focus:border-copilot"
        />
        <button
          onClick={() => void add()}
          disabled={!newLabel.trim()}
          className="rounded-md border border-line px-3 py-1.5 text-xs text-txt-dim hover:bg-bg-hover hover:text-txt-base disabled:cursor-not-allowed disabled:opacity-40"
        >
          ＋ 新增
        </button>
      </div>
    </div>
  )
}
