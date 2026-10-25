import { useEffect, useState, type ReactNode } from 'react'
import type { AppPaths, LaunchAtLoginState } from '@shared/types'
import { TERMINAL_FONT_SIZE_DEFAULT, TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN } from '@shared/types'
import { useApp } from '../store/sessions'
import { SHORTCUTS } from '../shortcuts'
import { LibraryHeader } from './LibraryHeader'
import { AccountsManager } from './AccountsManager'
import { RuntimeSettings } from './RuntimeSettings'

const BTN =
  'rounded-md border border-line px-3 py-1.5 text-xs text-txt-dim hover:bg-bg-hover hover:text-txt-base disabled:cursor-not-allowed disabled:opacity-40'

/** One titled block of the settings page. */
function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="space-y-3 border-t border-line py-5 first:border-t-0 first:pt-0">
      <h2 className="text-sm font-medium">{title}</h2>
      {children}
    </section>
  )
}

/**
 * A checkbox row. The longer explanation lives in the tooltip rather than on
 * the page, so the page stays scannable.
 */
function Toggle(props: {
  label: string
  hint: string
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}): JSX.Element {
  return (
    <label title={props.hint} className={`flex items-center gap-3 ${props.disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
        className="h-4 w-4 shrink-0 accent-copilot"
      />
      <span className="text-sm">{props.label}</span>
    </label>
  )
}

export function SettingsPanel(): JSX.Element {
  const {
    settings,
    saveDefaultCwd,
    pickNextCwd,
    setRestoreTabs,
    setCloseToTray,
    setAgentBridge,
    setAutoApprove,
    setNotifyOnAttention,
    terminalFontSize,
    setTerminalFontSize,
    update,
    installingUpdate,
    setCheckUpdatesOnLaunch,
    checkForUpdate,
    installUpdate
  } = useApp()
  const [draft, setDraft] = useState(settings?.defaultCwd ?? '')
  const [saved, setSaved] = useState(false)
  const [paths, setPaths] = useState<AppPaths | null>(null)
  const [checking, setChecking] = useState(false)

  const runCheck = async (): Promise<void> => {
    setChecking(true)
    try {
      await checkForUpdate()
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    void window.api.getAppPaths().then(setPaths)
  }, [])
  // Held here rather than in the app store because the OS owns it: it is read
  // back on every visit so a change made in Windows Settings or Task Manager
  // shows up here instead of this panel asserting something stale.
  const [launchAtLogin, setLaunchAtLoginState] = useState<LaunchAtLoginState>({
    supported: false,
    enabled: false
  })

  useEffect(() => {
    void window.api.getLaunchAtLogin().then(setLaunchAtLoginState)
  }, [])

  const toggleLaunchAtLogin = async (enabled: boolean): Promise<void> => {
    // Trust what the OS reports afterwards, not what we asked for.
    setLaunchAtLoginState(await window.api.setLaunchAtLogin(enabled))
  }

  // Settings arrive asynchronously and this panel is reachable before they do.
  // Without resyncing, the draft stays '' while the real value loads, which
  // makes the form look dirty and lets one click save an empty defaultCwd.
  useEffect(() => {
    setDraft(settings?.defaultCwd ?? '')
  }, [settings?.defaultCwd])

  const dirty = draft.trim() !== (settings?.defaultCwd ?? '')

  const save = async (): Promise<void> => {
    if (!dirty || !draft.trim()) return
    await saveDefaultCwd(draft.trim())
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1500)
  }

  const browse = async (): Promise<void> => {
    await pickNextCwd()
    // pickNextCwd updates nextCwd; mirror it into the draft for convenience.
    const latest = useApp.getState().nextCwd
    if (latest) setDraft(latest)
  }

  const updateStatus = update
    ? update.error
      ? update.error
      : update.latestVersion
        ? `有新版本 ${update.latestVersion}`
        : `已是最新（${new Date(update.checkedAt).toLocaleTimeString()}）`
    : ''

  return (
    <div className="flex h-full flex-col">
      <LibraryHeader>
        <span className="text-sm font-medium">設定</span>
      </LibraryHeader>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="max-w-2xl">
          <Section title="預設工作目錄">
            <div className="flex gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void save()}
                title="新開的 session 從這裡啟動；工具列的資料夾按鈕可以臨時改這一次"
                className="flex-1 rounded-md border border-line bg-bg-base px-3 py-2 text-sm outline-none focus:border-copilot"
              />
              <button onClick={() => void browse()} className={BTN}>
                瀏覽…
              </button>
              <button
                onClick={() => void save()}
                disabled={!dirty}
                className={`rounded-md px-4 py-1.5 text-xs font-medium ${
                  dirty ? 'bg-copilot text-white hover:opacity-90' : 'cursor-not-allowed bg-bg-panel text-txt-dim'
                }`}
              >
                {saved ? '已儲存 ✓' : '儲存'}
              </button>
            </div>
          </Section>

          <Section title="CLI 執行環境">
            <RuntimeSettings />
          </Section>

          <Section title="帳號">
            <AccountsManager />
          </Section>

          <Section title="一般">
            <Toggle
              label="啟動時還原上次的分頁"
              hint="重開 App 時開回上次的 Claude／Codex／Antigravity 分頁並續聊；Shell 分頁不還原。"
              checked={settings?.restoreTabs ?? true}
              onChange={(v) => void setRestoreTabs(v)}
            />
            <Toggle
              label="關閉視窗時縮到系統匣"
              hint="按 ✕ 只收起視窗，session 繼續跑；要結束請用系統匣選單的「結束」。"
              checked={settings?.closeToTray ?? true}
              onChange={(v) => void setCloseToTray(v)}
            />
            <Toggle
              label="背景分頁需要你時通知"
              hint="沒在看的分頁跑完、等確認或響鈴時，跳 Windows 通知並閃工作列。"
              checked={settings?.notifyOnAttention ?? true}
              onChange={(v) => void setNotifyOnAttention(v)}
            />
            <Toggle
              label="允許 AI 開分頁跟其他 AI 對話"
              hint="開一個本機介面（只限這台電腦、需要 token），讓 AI 開出唯讀的 🤖 分頁並在裡面打字，你可以在旁邊看。只能操作它自己開的分頁。"
              checked={settings?.agentBridge ?? true}
              onChange={(v) => void setAgentBridge(v)}
            />
            <Toggle
              label="Antigravity：自動允許所有權限"
              hint="新開的 Antigravity 分頁不再逐一詢問，執行指令、改檔案都直接做（--dangerously-skip-permissions）。唯讀的 🤖 分頁不受影響。已開的分頁要重開才會套用。"
              checked={settings?.autoApprove?.antigravity ?? false}
              onChange={(v) => void setAutoApprove('antigravity', v)}
            />
            <Toggle
              label="開機時自動啟動"
              hint={
                launchAtLogin.supported
                  ? '直接讀寫 Windows 的啟動設定，在系統裡改掉這裡也會跟著變。'
                  : '只有安裝版可用，開發版無法設定。'
              }
              checked={launchAtLogin.enabled}
              disabled={!launchAtLogin.supported}
              onChange={(v) => void toggleLaunchAtLogin(v)}
            />
          </Section>

          <Section title="終端">
            <div className="flex items-center gap-2" title="也可在終端裡用 Ctrl+= / Ctrl+- 調整，Ctrl+0 回預設">
              <span className="w-16 text-sm text-txt-dim">字體大小</span>
              <button
                onClick={() => void setTerminalFontSize(terminalFontSize - 1)}
                disabled={terminalFontSize <= TERMINAL_FONT_SIZE_MIN}
                className={BTN}
              >
                −
              </button>
              <span className="w-12 text-center font-mono text-sm tabular-nums">{terminalFontSize}px</span>
              <button
                onClick={() => void setTerminalFontSize(terminalFontSize + 1)}
                disabled={terminalFontSize >= TERMINAL_FONT_SIZE_MAX}
                className={BTN}
              >
                +
              </button>
              {terminalFontSize !== TERMINAL_FONT_SIZE_DEFAULT && (
                <button
                  onClick={() => void setTerminalFontSize(TERMINAL_FONT_SIZE_DEFAULT)}
                  className="ml-1 text-xs text-txt-dim hover:text-txt-base hover:underline"
                >
                  回預設
                </button>
              )}
            </div>

            <details>
              <summary className="cursor-pointer select-none text-sm text-txt-dim hover:text-txt-base">
                快速鍵
              </summary>
              <table className="mt-2 w-full text-xs">
                <tbody>
                  {SHORTCUTS.map((s) => (
                    <tr key={s.id} className="border-t border-line/60">
                      <td className="w-40 py-1.5 pr-3 font-mono text-txt-base">{s.keys}</td>
                      <td className="py-1.5 text-txt-dim">{s.label}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-line/60">
                    <td className="py-1.5 pr-3 font-mono text-txt-base">Ctrl+V · 右鍵</td>
                    <td className="py-1.5 text-txt-dim">貼上（圖片會貼成暫存 PNG 路徑）</td>
                  </tr>
                  <tr className="border-t border-line/60">
                    <td className="py-1.5 pr-3 font-mono text-txt-base">拖放檔案</td>
                    <td className="py-1.5 text-txt-dim">打出檔案路徑</td>
                  </tr>
                </tbody>
              </table>
            </details>
          </Section>

          <Section title="更新">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-txt-dim">
                版本 <span className="font-mono text-txt-base">{paths?.version ?? '…'}</span>
              </span>
              <button onClick={() => void runCheck()} disabled={checking} className={BTN}>
                {checking ? '檢查中…' : '檢查更新'}
              </button>
              {update?.latestVersion && (
                <button
                  onClick={() => void installUpdate()}
                  disabled={installingUpdate}
                  title="會結束所有 session，重開後依「還原上次的分頁」接回"
                  className="rounded-md bg-copilot px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {installingUpdate ? '下載中…' : `安裝 ${update.latestVersion}`}
                </button>
              )}
              <span className="text-xs text-txt-dim">{updateStatus}</span>
              <button
                onClick={() => void window.api.openReleasePage()}
                className="ml-auto text-xs text-txt-dim hover:text-txt-base hover:underline"
              >
                GitHub Releases ↗
              </button>
            </div>
            <Toggle
              label="自動檢查更新"
              hint="啟動後檢查一次，之後每 6 小時一次。"
              checked={settings?.checkUpdatesOnLaunch ?? true}
              onChange={(v) => void setCheckUpdatesOnLaunch(v)}
            />
          </Section>

          <Section title="資料">
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={() => void window.api.openAppPath('userData')} className={BTN}>
                開啟資料夾
              </button>
              <button onClick={() => void window.api.openAppPath('logs')} className={BTN}>
                開啟 log
              </button>
              <span className="min-w-0 truncate font-mono text-xs text-txt-dim" title={paths?.userData}>
                {paths?.userData ?? '…'}
              </span>
            </div>
          </Section>
        </div>
      </div>
    </div>
  )
}
