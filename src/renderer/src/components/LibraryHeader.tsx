import type { ReactNode } from 'react'
import { useApp } from '../store/sessions'

/**
 * Shared top bar for every "library" screen (Skills/Hooks/Todos/Accounts/
 * Settings/遊戲區): the "← 返回終端" back button, plus whatever
 * title/search/actions each screen needs passed in as children.
 */
export function LibraryHeader({ children }: { children: ReactNode }): JSX.Element {
  const { setView } = useApp()
  return (
    <div className="flex items-center gap-3 border-b border-line px-4 py-3">
      <button
        onClick={() => setView('terminal')}
        className="rounded-md px-2 py-1 text-sm text-txt-dim hover:bg-bg-hover hover:text-txt-base"
      >
        ← 返回終端
      </button>
      {children}
    </div>
  )
}
