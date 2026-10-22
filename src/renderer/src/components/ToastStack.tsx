import { useApp } from '../store/sessions'

/** Bottom-right stack of transient error toasts (see store.pushToast). */
export function ToastStack(): JSX.Element | null {
  const { toasts, dismissToast } = useApp()
  if (toasts.length === 0) return null

  return (
    <div className="pointer-events-none absolute bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex max-w-sm items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300 shadow-lg"
        >
          <span className="min-w-0 flex-1 break-words">{t.message}</span>
          <button
            onClick={() => dismissToast(t.id)}
            className="shrink-0 text-red-300/70 hover:text-red-300"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}
