import { useState } from 'react'
import { useApp } from '../store/sessions'
import { PROVIDER_UI } from '../providerUi'
import type { Provider } from '@shared/types'

const ORDER: Provider[] = ['claude', 'codex', 'copilot', 'antigravity', 'shell']

// Providers whose CLI keeps a resumable conversation history, so the split
// button's ▾ menu can offer 繼續上一次 (and, where the CLI has a picker,
// 選擇存檔…) as well as 新開對話.
const RESUMABLE: Provider[] = ['claude', 'codex', 'antigravity']
const PICKABLE: Provider[] = ['claude', 'codex']

/**
 * Launches a new CLI session with the chosen AI provider. Switching provider
 * means starting a fresh CLI (each provider is a different binary), so this acts
 * as the "＋ New CLI" control with a provider selector baked in. Claude/Codex
 * get a split button: the body opens a brand-new conversation, the ▾ exposes
 * continue-last and pick-a-save (the CLIs' own resume mechanisms).
 */
export function ProviderSwitch(): JSX.Element {
  const { providers, providersLoaded, creating, createSession, continueSession, pickSession } =
    useApp()
  const [openMenu, setOpenMenu] = useState<Provider | null>(null)

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-txt-dim">新開 CLI：</span>
      <div className="flex items-center gap-1 rounded-lg border border-line bg-bg-panel p-1">
        {ORDER.map((id) => {
          const meta = providers.find((p) => p.id === id)
          const ui = PROVIDER_UI[id]
          // Until detection has run, "not detected" would be a lie — probing
          // WSL takes seconds, and claiming the CLI is missing in the meantime
          // reads as a broken install.
          const available = providersLoaded && (meta?.available ?? false)
          const resumable = RESUMABLE.includes(id) && available
          return (
            <div key={id} className="relative flex items-center">
              <button
                disabled={!available || creating}
                title={
                  !providersLoaded
                    ? '正在偵測已安裝的 CLI…'
                    : available
                      ? `啟動 ${ui.label}（${meta?.runtime === 'wsl' ? 'WSL 版' : `Windows 版：${meta?.command}`}）`
                      : meta?.hint
                }
                onClick={() => void createSession(id)}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  available && !creating
                    ? 'text-txt-base hover:bg-bg-hover'
                    : 'cursor-not-allowed text-txt-dim/50'
                } ${resumable ? 'rounded-r-none' : ''}`}
              >
                <span className="h-2 w-2 rounded-full" style={{ background: ui.color }} />
                {ui.label}
                {!providersLoaded && <span className="text-[10px]">·偵測中</span>}
                {providersLoaded && !available && <span className="text-[10px]">·未偵測到</span>}
              </button>
              {resumable && (
                <button
                  title="更多開啟方式（繼續上一次／選擇存檔）"
                  onClick={() => setOpenMenu((m) => (m === id ? null : id))}
                  className="rounded-md rounded-l-none border-l border-line/60 px-1 py-1 text-xs text-txt-dim transition-colors hover:bg-bg-hover hover:text-txt-base"
                >
                  ▾
                </button>
              )}
              {openMenu === id && (
                <>
                  {/* click-away backdrop */}
                  <div className="fixed inset-0 z-10" onClick={() => setOpenMenu(null)} />
                  <div className="absolute right-0 top-full z-20 mt-1 w-52 rounded-lg border border-line bg-bg-panel py-1 shadow-lg">
                    <MenuItem
                      label="新開對話"
                      onClick={() => {
                        setOpenMenu(null)
                        void createSession(id)
                      }}
                    />
                    <MenuItem
                      label="繼續上一次"
                      hint={
                        id === 'codex' ? '同資料夾多個分頁只會接到最近一次' : '接續此資料夾最近的對話'
                      }
                      onClick={() => {
                        setOpenMenu(null)
                        void continueSession(id)
                      }}
                    />
                    {PICKABLE.includes(id) && (
                      <MenuItem
                        label="選擇存檔…"
                        hint={id === 'codex' ? '開 codex 內建存檔挑選器' : '開 claude 內建存檔挑選器'}
                        onClick={() => {
                          setOpenMenu(null)
                          void pickSession(id)
                        }}
                      />
                    )}
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function MenuItem({
  label,
  hint,
  onClick
}: {
  label: string
  hint?: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className="block w-full px-3 py-1.5 text-left text-xs text-txt-base transition-colors hover:bg-bg-hover"
    >
      {label}
      {hint && <span className="mt-0.5 block text-[10px] text-txt-dim">{hint}</span>}
    </button>
  )
}
