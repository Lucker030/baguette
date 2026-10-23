import type { Provider, RuntimePref } from '@shared/types'
import { PROVIDERS } from '@shared/types'
import { useApp } from '../store/sessions'
import { PROVIDER_UI } from '../providerUi'

const PREF_LABELS: Record<RuntimePref, string> = {
  auto: '自動',
  windows: 'Windows',
  wsl: 'WSL'
}

/** ✓ / — / … for one install, with the path (or why) as a tooltip. */
function Found({ value, title }: { value: boolean | null; title?: string }): JSX.Element {
  if (value === null) return <span className="text-txt-dim" title="WSL 偵測中…">…</span>
  return value ? (
    <span className="text-green-400" title={title}>
      ✓
    </span>
  ) : (
    <span className="text-txt-dim/60">—</span>
  )
}

/**
 * Per provider: whether a Windows and a WSL install were found, and which one
 * new tabs use. 自動 = Windows when installed there, else WSL.
 */
export function RuntimeSettings(): JSX.Element {
  const { providers, providersLoaded, setRuntimePref } = useApp()

  return (
    <div className="space-y-2">
      <p className="text-xs text-txt-dim">兩邊都有裝時選要用哪一版；「自動」= 有 Windows 版就用，沒有才用 WSL 版。</p>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-txt-dim">
            <th className="py-1 font-normal">CLI</th>
            <th className="w-20 py-1 text-center font-normal">Windows</th>
            <th className="w-20 py-1 text-center font-normal">WSL</th>
            <th className="w-48 py-1 font-normal">使用</th>
          </tr>
        </thead>
        <tbody>
          {PROVIDERS.map((id: Provider) => {
            const meta = providers.find((p) => p.id === id)
            const ui = PROVIDER_UI[id]
            const pref = meta?.pref ?? 'auto'
            return (
              <tr key={id} className="border-t border-line/60">
                <td className="py-1.5">
                  <span className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full" style={{ background: ui.color }} />
                    {ui.label}
                    {meta?.runtime && (
                      <span className="text-[11px] text-txt-dim">→ {meta.runtime === 'wsl' ? 'WSL 版' : 'Windows 版'}</span>
                    )}
                    {providersLoaded && meta && !meta.available && (
                      <span className="text-[11px] text-amber-400" title={meta.hint}>
                        無法使用
                      </span>
                    )}
                  </span>
                </td>
                <td className="py-1.5 text-center">
                  <Found value={providersLoaded ? !!meta?.windowsCommand : null} title={meta?.windowsCommand} />
                </td>
                <td className="py-1.5 text-center">
                  <Found value={providersLoaded ? (meta?.wslAvailable ?? null) : null} />
                </td>
                <td className="py-1.5">
                  <div className="flex w-fit gap-0.5 rounded-md border border-line bg-bg-panel p-0.5 text-xs">
                    {(Object.keys(PREF_LABELS) as RuntimePref[]).map((p) => (
                      <button
                        key={p}
                        onClick={() => void setRuntimePref(id, p)}
                        className={`rounded px-2 py-0.5 ${
                          p === pref ? 'bg-bg-hover text-txt-base' : 'text-txt-dim hover:text-txt-base'
                        }`}
                      >
                        {PREF_LABELS[p]}
                      </button>
                    ))}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
