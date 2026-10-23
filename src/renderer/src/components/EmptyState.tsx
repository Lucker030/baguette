import { useApp } from '../store/sessions'
import { PROVIDER_UI } from '../providerUi'
import type { Provider } from '@shared/types'
import breadIcon from '../assets/baguette.png'

export function EmptyState(): JSX.Element {
  const { providers, providersLoaded, creating, createSession } = useApp()

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-6 text-center">
      <img src={breadIcon} alt="" className="h-16 w-16" draggable={false} />
      <div>
        <h1 className="text-lg font-semibold">歡迎使用 baguette</h1>
        <p className="mt-1 text-sm text-txt-dim">選一個供應商開始你的第一個 CLI session</p>
      </div>
      <div className="flex gap-3">
        {(['claude', 'codex', 'copilot', 'shell'] as Provider[]).map((id) => {
          const meta = providers.find((p) => p.id === id)
          const ui = PROVIDER_UI[id]
          // Detection is slow (it may probe WSL); don't claim "未偵測到" while
          // it is still running — see ProviderSwitch.
          const available = providersLoaded && (meta?.available ?? false)
          return (
            <button
              key={id}
              disabled={!available || creating}
              title={!providersLoaded ? '正在偵測已安裝的 CLI…' : available ? undefined : meta?.hint}
              onClick={() => void createSession(id)}
              className={`flex min-w-[120px] flex-col items-center gap-2 rounded-xl border px-5 py-4 transition-colors ${
                available && !creating
                  ? 'border-line bg-bg-panel hover:bg-bg-hover'
                  : 'cursor-not-allowed border-line/50 bg-bg-panel/40 opacity-50'
              }`}
            >
              <span className="h-3 w-3 rounded-full" style={{ background: ui.color }} />
              <span className="text-sm font-medium">{ui.label}</span>
              <span className="text-[11px] text-txt-dim">
                {!providersLoaded ? '偵測中…' : available ? '可用' : '未偵測到'}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
