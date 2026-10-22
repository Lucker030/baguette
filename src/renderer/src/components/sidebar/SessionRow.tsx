import { useState } from 'react'
import type { SessionInfo } from '@shared/types'
import { PROVIDER_UI } from '../../providerUi'

interface SessionRowProps {
  session: SessionInfo
  /** Fallback label when the user hasn't renamed the tab, e.g. "Claude #2". */
  defaultLabel: string
  customName?: string
  isActive: boolean
  /** Output is flowing right now. */
  busy?: boolean
  /** Finished/stopped while the user was elsewhere and hasn't been looked at since. */
  attention?: boolean
  onSelect: () => void
  onRename: (name: string) => void
  onClose: () => void
  onDragStart: () => void
  onDragEnd: () => void
}

/**
 * One session tab in the sidebar, including its inline rename editor.
 * Rename state is local: nothing outside this row cares whether it is being
 * edited, so keeping it here avoids re-rendering the whole sidebar per keystroke.
 */
export function SessionRow({
  session,
  defaultLabel,
  customName,
  isActive,
  busy = false,
  attention = false,
  onSelect,
  onRename,
  onClose,
  onDragStart,
  onDragEnd
}: SessionRowProps): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  /** What the editor was seeded with, so an untouched edit commits nothing. */
  const [seed, setSeed] = useState('')

  const ui = PROVIDER_UI[session.provider]
  const label = customName ?? defaultLabel

  const commit = (): void => {
    // Blur commits, so double-clicking a never-renamed tab and clicking away
    // would otherwise freeze its auto-generated label ("Claude #2") in as a
    // custom name — after which it stops tracking the numbering and two tabs
    // can end up displaying the same thing.
    if (draft !== seed) onRename(draft)
    setEditing(false)
  }

  if (editing) {
    return (
      <li>
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') setEditing(false)
          }}
          onBlur={commit}
          placeholder={defaultLabel}
          className="w-full rounded-md border border-copilot bg-bg-base px-2 py-1 text-sm outline-none"
        />
      </li>
    )
  }

  return (
    <li>
      <button
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={onSelect}
        onDoubleClick={(e) => {
          e.stopPropagation()
          setDraft(label)
          setSeed(label)
          setEditing(true)
        }}
        title={attention ? '這個 session 停下來了，可能在等你' : busy ? '執行中' : '點兩下改名'}
        className={`group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
          isActive ? 'bg-bg-hover text-txt-base' : attention ? 'text-txt-base hover:bg-bg-elev' : 'text-txt-dim hover:bg-bg-elev'
        }`}
      >
        {/* Provider dot doubles as the activity indicator: it pulses while
            output is flowing, so a glance at the sidebar shows which tabs
            are working without opening them. */}
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${busy && session.status === 'running' ? 'animate-pulse' : ''}`}
          style={{
            background: ui.color,
            opacity: session.status === 'exited' || session.status === 'error' ? 0.35 : 1
          }}
        />
        <span className={`min-w-0 flex-1 truncate ${attention ? 'font-medium' : ''}`}>
          {label}
          {session.status === 'running' && session.authState === 'needsLogin' && (
            <span className="text-amber-400"> · 需要登入</span>
          )}
          {session.status === 'exited' && <span className="text-txt-dim"> · 已結束</span>}
          {session.status === 'error' && <span className="text-red-400"> · 錯誤</span>}
        </span>
        {attention && (
          <span
            className="h-2 w-2 shrink-0 rounded-full bg-amber-400 shadow-[0_0_6px_1px_rgba(251,191,36,0.6)] group-hover:hidden"
            aria-label="需要你"
          />
        )}
        <span
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          className="hidden shrink-0 rounded px-1 text-txt-dim hover:bg-bg-base hover:text-txt-base group-hover:block"
          title="關閉"
        >
          ✕
        </span>
      </button>
    </li>
  )
}
