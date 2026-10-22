import { useState } from 'react'
import type { Account } from '@shared/types'
import { AccountSelect } from './AccountSelect'

export interface Bucket {
  id: string | null
  name: string
  removable: boolean
  /** Bound Claude account id ('default' or an Account.id); null for 未分組. */
  accountId: string | null
}

interface GroupHeaderProps {
  bucket: Bucket
  memberCount: number
  accounts: Account[]
  collapsed: boolean
  isSelected: boolean
  isDropTarget: boolean
  accountLabel: (accountId: string | undefined) => string
  onToggleCollapse: () => void
  onSelect: () => void
  onRename: (name: string) => void
  onSetAccount: (accountId: string) => void
  onRemove: () => void
  onAddSession: () => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: React.DragEvent) => void
}

/**
 * The group (bucket) header row: collapse toggle, name, member count, bound
 * account badge, and the hover actions. Doubles as the drop target for
 * dragging a session into this group. Rename editing is local state.
 */
export function GroupHeader({
  bucket,
  memberCount,
  accounts,
  collapsed,
  isSelected,
  isDropTarget,
  accountLabel,
  onToggleCollapse,
  onSelect,
  onRename,
  onSetAccount,
  onRemove,
  onAddSession,
  onDragOver,
  onDragLeave,
  onDrop
}: GroupHeaderProps): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`group flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-semibold uppercase tracking-wider transition-colors ${
        isSelected ? 'text-txt-base' : 'text-txt-dim'
      } ${isDropTarget ? 'bg-copilot/20 ring-1 ring-copilot/50' : 'hover:bg-bg-elev'}`}
    >
      <button
        onClick={onToggleCollapse}
        className="shrink-0 px-0.5 text-txt-dim hover:text-txt-base"
        title={collapsed ? '展開' : '收合'}
      >
        {collapsed ? '▸' : '▾'}
      </button>

      {editing ? (
        <>
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onRename(draft)
                setEditing(false)
              }
              if (e.key === 'Escape') setEditing(false)
            }}
            className="min-w-0 flex-1 rounded border border-line bg-bg-base px-1 py-0.5 text-xs normal-case tracking-normal outline-none focus:border-copilot"
          />
          <AccountSelect
            value={bucket.accountId ?? 'default'}
            accounts={accounts}
            onChange={onSetAccount}
            onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
            title="這個群組綁定的 Claude 帳號"
            className="shrink-0 rounded border border-line bg-bg-base px-1 py-0.5 text-[10px] normal-case tracking-normal text-txt-dim outline-none focus:border-copilot"
          />
          <button
            onClick={() => setEditing(false)}
            className="shrink-0 rounded px-1 text-txt-dim hover:text-txt-base"
            title="完成"
          >
            ✓
          </button>
        </>
      ) : (
        <button
          onClick={onSelect}
          className="min-w-0 flex-1 truncate text-left"
          title="點一下跳到此群組的 session"
        >
          {bucket.name}
          <span className="ml-1 text-txt-dim">{memberCount}</span>
          {bucket.id && (
            <span className="ml-1.5 rounded bg-bg-elev px-1 py-0.5 text-[9px] normal-case tracking-normal text-txt-dim">
              {accountLabel(bucket.accountId ?? undefined)}
            </span>
          )}
        </button>
      )}

      {!editing && (
        <span
          onClick={(e) => {
            e.stopPropagation()
            onAddSession()
          }}
          className="hidden shrink-0 cursor-pointer rounded px-1 text-txt-dim hover:text-txt-base group-hover:block"
          title="在這個群組新增一個 Claude session"
        >
          ＋
        </span>
      )}
      {bucket.removable && !editing && (
        <>
          <span
            onClick={() => {
              setDraft(bucket.name)
              setEditing(true)
            }}
            className="hidden shrink-0 cursor-pointer rounded px-1 text-txt-dim hover:text-txt-base group-hover:block"
            title="改名"
          >
            ✎
          </span>
          <span
            onClick={onRemove}
            className="hidden shrink-0 cursor-pointer rounded px-1 text-txt-dim hover:text-red-400 group-hover:block"
            title="刪除群組（session 移回未分組）"
          >
            ✕
          </span>
        </>
      )}
    </div>
  )
}
