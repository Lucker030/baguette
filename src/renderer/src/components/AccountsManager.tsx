import { useState } from 'react'
import { useApp } from '../store/sessions'

export function AccountsManager(): JSX.Element {
  const {
    settings,
    addAccount,
    renameAccount,
    removeAccount,
    setCurrentAccount,
    createSession
  } = useApp()
  const [newLabel, setNewLabel] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState('')

  const accounts = settings?.accounts ?? []
  const currentId = settings?.currentAccountId ?? null

  const add = async (): Promise<void> => {
    const label = newLabel.trim()
    if (!label) return
    await addAccount(label)
    setNewLabel('')
  }

  const login = (id: string | null): void => {
    // Open a Claude session bound to this account and run `claude`. We scan the
    // early output for the login URL ourselves and open it via Electron's
    // shell.openExternal, since the CLI's own browser-launch is unreliable
    // inside this app's pty — the terminal fallback (press `c` to copy) still
    // works if detection misses it. /login re-auths, /logout signs out.
    void createSession('claude', { accountId: id ?? 'default', autoOpenLoginUrl: true })
  }

  // The built-in default account is rendered as a fixed first row.
  const rows: { id: string | null; label: string; dir: string; removable: boolean }[] = [
    { id: null, label: '預設帳號', dir: '~/.claude', removable: false },
    ...accounts.map((a) => ({ id: a.id, label: a.label, dir: a.configDir, removable: true }))
  ]

  return (
    <div className="max-w-2xl space-y-3">
      <h2 className="text-sm font-medium">Claude 帳號</h2>

      <div className="space-y-2 text-xs leading-relaxed text-txt-dim">
        <p>
          每個帳號是一份獨立的 Claude 設定/憑證目錄（官方環境變數 <code>CLAUDE_CONFIG_DIR</code>，
          憑證存在該目錄下的 <code>.credentials.json</code>）。選「設為目前」後，從上方新開的 Claude
          session 就會用該帳號。
        </p>
        <p>
          <span className="text-txt-base">登入方式：</span>按「登入」會開一個綁定該帳號的分頁並執行{' '}
          <code>claude</code>。若該帳號還沒登入過，這個 App 會自動偵測登入連結並{' '}
          <span className="text-txt-base">直接幫你開啟瀏覽器</span>
          （不依賴 CLI 自己叫瀏覽器，較可靠），讓你用 Claude Pro / Max 訂閱或 Console 帳號登入；
          若沒偵測到，終端分頁上方會跳出連結可手動開啟，或在終端按 <code>c</code> 複製登入網址。
          已登入過則直接可用。
        </p>
        <p>
          之後在終端可用 <code>/login</code> 重新登入或切換身分、<code>/logout</code> 登出、
          <code>/status</code> 查看目前登入的帳號與方案。
        </p>
      </div>

      <div className="flex gap-2 pt-2">
        <input
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
          placeholder="新帳號名稱，例如 work、personal"
          className="flex-1 rounded-md border border-line bg-bg-base px-3 py-2 text-sm outline-none focus:border-copilot"
        />
        <button
          onClick={() => void add()}
          className="rounded-md bg-copilot px-4 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          ＋ 新增帳號
        </button>
      </div>

      <ul className="space-y-2">
        {rows.map((row) => {
          const isCurrent = (row.id ?? null) === currentId
          const isEditing = editingId === row.id
          return (
            <li
              key={row.id ?? '__default__'}
              className={`rounded-lg border px-3 py-2.5 ${
                isCurrent ? 'border-copilot/60 bg-bg-hover' : 'border-line bg-bg-panel'
              }`}
            >
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void setCurrentAccount(row.id)}
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
                  title="開分頁並執行 claude；未登入過會自動開瀏覽器登入"
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
              <div className="mt-1 pl-6 text-[11px] text-txt-dim">
                <code className="break-all">{row.dir}</code>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
