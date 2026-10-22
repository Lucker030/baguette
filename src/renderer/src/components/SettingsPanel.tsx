import { useEffect, useState } from 'react'
import type { AppPaths, LaunchAtLoginState } from '@shared/types'
import { TERMINAL_FONT_SIZE_DEFAULT, TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN } from '@shared/types'
import { useApp } from '../store/sessions'
import { SHORTCUTS } from '../shortcuts'
import { LibraryHeader } from './LibraryHeader'
import { AccountsManager } from './AccountsManager'

export function SettingsPanel(): JSX.Element {
  const {
    settings,
    saveDefaultCwd,
    pickNextCwd,
    setRestoreTabs,
    setCloseToTray,
    setNotifyOnAttention,
    terminalFontSize,
    setTerminalFontSize,
    update,
    installingUpdate,
    setUpdateDir,
    setCheckUpdatesOnLaunch,
    checkForUpdate,
    installUpdate
  } = useApp()
  const [draft, setDraft] = useState(settings?.defaultCwd ?? '')
  const [saved, setSaved] = useState(false)
  const [paths, setPaths] = useState<AppPaths | null>(null)
  const [updateDirDraft, setUpdateDirDraft] = useState(settings?.updateDir ?? '')
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    setUpdateDirDraft(settings?.updateDir ?? '')
  }, [settings?.updateDir])

  const updateDirDirty = updateDirDraft.trim() !== (settings?.updateDir ?? '')

  const saveUpdateDir = async (): Promise<void> => {
    await setUpdateDir(updateDirDraft.trim())
    if (updateDirDraft.trim()) await runCheck()
  }

  const browseUpdateDir = async (): Promise<void> => {
    const dir = await window.api.pickDirectory()
    if (dir) setUpdateDirDraft(dir)
  }

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

  return (
    <div className="flex h-full flex-col">
      <LibraryHeader>
        <span className="text-sm font-medium">設定</span>
      </LibraryHeader>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="max-w-2xl space-y-2">
          <label className="block text-sm font-medium">預設工作目錄</label>
          <p className="text-xs text-txt-dim">
            新開的 CLI session 會從這個資料夾啟動。開新 session 前也可在上方工具列的資料夾按鈕臨時改這一次要用的目錄。
          </p>
          <div className="flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="例如 C:\\Users\\you\\projects"
              className="flex-1 rounded-md border border-line bg-bg-base px-3 py-2 text-sm outline-none focus:border-copilot"
            />
            <button
              onClick={() => void browse()}
              className="rounded-md border border-line px-3 py-2 text-sm text-txt-dim hover:bg-bg-hover hover:text-txt-base"
            >
              瀏覽…
            </button>
            <button
              onClick={() => void save()}
              disabled={!dirty}
              className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                dirty
                  ? 'bg-copilot text-white hover:opacity-90'
                  : 'cursor-not-allowed bg-bg-panel text-txt-dim'
              }`}
            >
              {saved ? '已儲存 ✓' : '儲存'}
            </button>
          </div>
        </div>

        <div className="mt-8 border-t border-line pt-6">
          <AccountsManager />
        </div>

        <div className="mt-8 max-w-2xl space-y-4 border-t border-line pt-6">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={settings?.restoreTabs ?? true}
              onChange={(e) => void setRestoreTabs(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-copilot"
            />
            <span>
              <span className="block text-sm font-medium">重新開啟時還原上次的分頁</span>
              <span className="mt-1 block text-xs text-txt-dim">
                下次啟動 App 時，自動開回上次的 Claude／ChatGPT 分頁與群組，並各自續聊之前的對話。Shell／Python
                等臨時分頁不會還原。ChatGPT（Codex）同一資料夾的多個分頁只能還原到最近一次對話。
              </span>
            </span>
          </label>

          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={settings?.closeToTray ?? true}
              onChange={(e) => void setCloseToTray(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-copilot"
            />
            <span>
              <span className="block text-sm font-medium">關閉視窗時縮到系統匣</span>
              <span className="mt-1 block text-xs text-txt-dim">
                按 ✕ 只是把視窗收起來，所有 session 繼續跑；點系統匣圖示就回來。要真的結束請用系統匣選單的「結束」。
                關掉這個選項的話，關視窗就等於結束所有 session。
              </span>
            </span>
          </label>

          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={settings?.notifyOnAttention ?? true}
              onChange={(e) => void setNotifyOnAttention(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-copilot"
            />
            <span>
              <span className="block text-sm font-medium">背景 session 需要你時跳 Windows 通知</span>
              <span className="mt-1 block text-xs text-txt-dim">
                某個沒在看的分頁跑完一輪、停在確認提示、或響鈴時，側欄會亮黃點；如果視窗不在前面，另外跳一則系統通知並閃工作列。點通知就會跳到那個分頁。
              </span>
            </span>
          </label>

          <label className={`flex items-start gap-3 ${launchAtLogin.supported ? '' : 'opacity-60'}`}>
            <input
              type="checkbox"
              checked={launchAtLogin.enabled}
              disabled={!launchAtLogin.supported}
              onChange={(e) => void toggleLaunchAtLogin(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-copilot"
            />
            <span>
              <span className="block text-sm font-medium">開機時自動啟動</span>
              <span className="mt-1 block text-xs text-txt-dim">
                {launchAtLogin.supported
                  ? '登入 Windows 後自動開啟這個 App。這個開關直接讀寫系統設定，所以你在 Windows「設定 → 應用程式 → 啟動」或工作管理員裡改掉，這裡也會跟著變。'
                  : '這個開關只在安裝好的版本可用。目前是從原始碼直接執行的開發版，登錄下去會指向 node_modules 裡的 electron.exe 而不是安裝好的 App。'}
              </span>
            </span>
          </label>
        </div>

        <div className="mt-8 max-w-2xl space-y-2 border-t border-line pt-6">
          <label className="block text-sm font-medium">終端字體大小</label>
          <p className="text-xs text-txt-dim">
            套用到每個終端。在終端裡也可以用 Ctrl+= / Ctrl+- 調整，Ctrl+0 回預設（{TERMINAL_FONT_SIZE_DEFAULT}px）。
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void setTerminalFontSize(terminalFontSize - 1)}
              disabled={terminalFontSize <= TERMINAL_FONT_SIZE_MIN}
              className="rounded-md border border-line px-3 py-1 text-sm text-txt-dim hover:bg-bg-hover hover:text-txt-base disabled:cursor-not-allowed disabled:opacity-40"
            >
              −
            </button>
            <span className="w-14 text-center font-mono text-sm tabular-nums">{terminalFontSize}px</span>
            <button
              onClick={() => void setTerminalFontSize(terminalFontSize + 1)}
              disabled={terminalFontSize >= TERMINAL_FONT_SIZE_MAX}
              className="rounded-md border border-line px-3 py-1 text-sm text-txt-dim hover:bg-bg-hover hover:text-txt-base disabled:cursor-not-allowed disabled:opacity-40"
            >
              +
            </button>
            {terminalFontSize !== TERMINAL_FONT_SIZE_DEFAULT && (
              <button
                onClick={() => void setTerminalFontSize(TERMINAL_FONT_SIZE_DEFAULT)}
                className="ml-2 text-xs text-txt-dim underline-offset-2 hover:text-txt-base hover:underline"
              >
                回預設
              </button>
            )}
          </div>
        </div>

        <div className="mt-8 max-w-2xl space-y-2 border-t border-line pt-6">
          <label className="block text-sm font-medium">快速鍵</label>
          <p className="text-xs text-txt-dim">
            跟 Windows Terminal 一樣走 Ctrl+Shift，單純的 Ctrl+字母留給 CLI 自己用（Ctrl+C 中斷、Ctrl+F 在 readline 是往右一格）。
          </p>
          <table className="w-full text-xs">
            <tbody>
              {SHORTCUTS.map((s) => (
                <tr key={s.id} className="border-t border-line/60">
                  <td className="w-40 py-1.5 pr-3 font-mono text-txt-base">{s.keys}</td>
                  <td className="py-1.5 text-txt-dim">{s.label}</td>
                </tr>
              ))}
              <tr className="border-t border-line/60">
                <td className="py-1.5 pr-3 font-mono text-txt-base">Ctrl+V · 右鍵</td>
                <td className="py-1.5 text-txt-dim">貼上（剪貼簿是圖片時，貼成暫存 PNG 的路徑）</td>
              </tr>
              <tr className="border-t border-line/60">
                <td className="py-1.5 pr-3 font-mono text-txt-base">拖放檔案</td>
                <td className="py-1.5 text-txt-dim">把檔案或資料夾拖進終端，會打出它的路徑</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="mt-8 max-w-2xl space-y-3 border-t border-line pt-6">
          <label className="block text-sm font-medium">更新</label>
          <p className="text-xs text-txt-dim">
            目前版本 <span className="font-mono text-txt-base">{paths?.version ?? '…'}</span>。
            沒有線上更新伺服器；指定一個資料夾（本機路徑或網路共享都可以），App 會去找裡面比現在新的
            <span className="font-mono"> Local Platform Setup X.Y.Z.exe</span>，有就提示。
            安裝會先把檔案複製到本機、用同資料夾的 latest.yml 驗 sha512、靜默安裝、再自動重開 App。
          </p>
          <div className="flex gap-2">
            <input
              value={updateDirDraft}
              onChange={(e) => setUpdateDirDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && updateDirDirty) void saveUpdateDir()
              }}
              placeholder="例如 \\\\nas\\share\\dashboard 或 D:\\releases（留空 = 不檢查）"
              className="flex-1 rounded-md border border-line bg-bg-base px-3 py-2 text-sm outline-none focus:border-copilot"
            />
            <button
              onClick={() => void browseUpdateDir()}
              className="rounded-md border border-line px-3 py-2 text-sm text-txt-dim hover:bg-bg-hover hover:text-txt-base"
            >
              瀏覽…
            </button>
            <button
              onClick={() => void saveUpdateDir()}
              disabled={!updateDirDirty}
              className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                updateDirDirty ? 'bg-copilot text-white hover:opacity-90' : 'cursor-not-allowed bg-bg-panel text-txt-dim'
              }`}
            >
              儲存
            </button>
          </div>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={settings?.checkUpdatesOnLaunch ?? true}
              disabled={!settings?.updateDir}
              onChange={(e) => void setCheckUpdatesOnLaunch(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-copilot"
            />
            <span className="text-sm">啟動後自動檢查，之後每 6 小時再檢查一次</span>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => void runCheck()}
              disabled={checking || !settings?.updateDir}
              className="rounded-md border border-line px-3 py-1.5 text-xs text-txt-dim hover:bg-bg-hover hover:text-txt-base disabled:cursor-not-allowed disabled:opacity-40"
            >
              {checking ? '檢查中…' : '立即檢查'}
            </button>
            {update?.latestVersion && (
              <button
                onClick={() => void installUpdate()}
                disabled={installingUpdate}
                className="rounded-md bg-copilot px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {installingUpdate ? '準備安裝中…' : `安裝 ${update.latestVersion} 並重新啟動`}
              </button>
            )}
            <span className="text-xs text-txt-dim">
              {update
                ? update.error
                  ? update.error
                  : update.latestVersion
                    ? `找到新版本 ${update.latestVersion}${update.sha512 ? '（有 latest.yml，安裝前會校驗）' : '（沒有 latest.yml，不校驗）'}`
                    : `已是最新（${new Date(update.checkedAt).toLocaleTimeString()} 檢查）`
                : settings?.updateDir
                  ? '還沒檢查'
                  : ''}
            </span>
          </div>
          {update?.latestVersion && (
            <p className="text-xs text-txt-dim">
              安裝會結束所有 session（跟關閉 App 一樣），重開後依「還原上次的分頁」設定接回對話。
            </p>
          )}
        </div>

        <div className="mt-8 max-w-2xl space-y-2 border-t border-line pt-6">
          <label className="block text-sm font-medium">資料與 log</label>
          <p className="text-xs text-txt-dim">
            設定、分頁快照、代辦、知識庫都是這個資料夾裡的 JSON。主程序和介面的錯誤會寫進 logs/main.log，出問題先看這裡。
          </p>
          <div className="break-all font-mono text-xs text-txt-dim">{paths?.userData ?? '…'}</div>
          <div className="flex gap-2">
            <button
              onClick={() => void window.api.openAppPath('logs')}
              className="rounded-md border border-line px-3 py-1.5 text-xs text-txt-dim hover:bg-bg-hover hover:text-txt-base"
            >
              開啟 log 資料夾
            </button>
            <button
              onClick={() => void window.api.openAppPath('userData')}
              className="rounded-md border border-line px-3 py-1.5 text-xs text-txt-dim hover:bg-bg-hover hover:text-txt-base"
            >
              開啟資料資料夾
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
