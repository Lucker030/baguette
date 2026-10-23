import { useState } from 'react'
import { useApp } from '../store/sessions'
import type { SessionInfo } from '@shared/types'
import { PROVIDER_UI } from '../providerUi'
import { AccountSelect } from './sidebar/AccountSelect'
import { AddonNav } from './sidebar/AddonNav'
import { GroupHeader, type Bucket } from './sidebar/GroupHeader'
import { SessionRow } from './sidebar/SessionRow'
import breadIcon from '../assets/baguette.png'

export function Sidebar(): JSX.Element {
  const {
    sessions,
    activeId,
    view,
    settings,
    selectedGroupId,
    sessionGroupId,
    sessionName,
    collapsedGroups,
    sessionBusy,
    attention,
    setActive,
    closeSession,
    renameSession,
    createSession,
    addGroup,
    renameGroup,
    setGroupAccount,
    removeGroup,
    selectGroup,
    moveSessionToGroup,
    toggleGroupCollapse
  } = useApp()

  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newAccountId, setNewAccountId] = useState('default')
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const accounts = settings?.accounts ?? []

  const accountLabel = (accountId: string | undefined): string =>
    (accountId && accountId !== 'default' ? accounts.find((a) => a.id === accountId)?.label : null) ??
    '預設帳號'

  const currentAccount = accounts.find((a) => a.id === settings?.currentAccountId)?.label ?? '預設'

  // Stable per-provider display number based on original arrival order.
  const numberOf = new Map<string, number>()
  const counts: Record<string, number> = {}
  sessions.forEach((s) => {
    counts[s.provider] = (counts[s.provider] ?? 0) + 1
    numberOf.set(s.id, counts[s.provider])
  })

  const groups = settings?.groups ?? []
  const buckets: Bucket[] = [
    { id: null, name: '未分組', removable: false, accountId: null },
    ...groups.map((g) => ({ id: g.id, name: g.name, removable: true, accountId: g.accountId }))
  ]

  const membersOf = (id: string | null): SessionInfo[] =>
    sessions.filter((s) => (sessionGroupId[s.id] ?? null) === id)

  const bucketKey = (id: string | null): string => id ?? '__ungrouped__'

  const submitNew = async (): Promise<void> => {
    await addGroup(newName, newAccountId)
    setNewName('')
    setNewAccountId('default')
    setCreating(false)
  }

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-bg-panel">
      <div className="flex items-center gap-2 px-4 py-3.5">
        <img src={breadIcon} alt="" className="h-7 w-7" draggable={false} />
        <div className="text-sm font-semibold tracking-wide">baguette</div>
      </div>

      <div className="flex items-center justify-between px-3 pb-1 pt-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-txt-dim">
          CLI Sessions
        </span>
        <button
          onClick={() => {
            setNewAccountId(settings?.currentAccountId ?? 'default')
            setCreating((v) => !v)
          }}
          title="新增群組"
          className="rounded px-1.5 text-sm text-txt-dim hover:bg-bg-elev hover:text-txt-base"
        >
          ＋群組
        </button>
      </div>

      {creating && (
        <div className="space-y-1 px-2 pb-1">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitNew()
              if (e.key === 'Escape') {
                setCreating(false)
                setNewName('')
              }
            }}
            placeholder="群組名稱，Enter 建立"
            className="w-full rounded-md border border-line bg-bg-base px-2 py-1 text-sm outline-none focus:border-copilot"
          />
          <AccountSelect
            value={newAccountId}
            accounts={accounts}
            onChange={setNewAccountId}
            prefix="身分："
            title="這個群組綁定的 Claude 帳號，裡面新開的 session 一律用這個身分"
            className="w-full rounded-md border border-line bg-bg-base px-2 py-1 text-xs text-txt-dim outline-none focus:border-copilot"
          />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {sessions.length === 0 && groups.length === 0 && (
          <div className="px-2 py-3 text-xs text-txt-dim">尚無 session，從上方新開一個 CLI。</div>
        )}

        <div className="space-y-1">
          {buckets.map((b) => {
            const members = membersOf(b.id)
            // Skip the empty 未分組 bucket unless it's the only thing / is selected.
            if (b.id === null && members.length === 0 && groups.length > 0) return null
            const collapsed = collapsedGroups[bucketKey(b.id)] ?? false

            return (
              <div key={bucketKey(b.id)}>
                <GroupHeader
                  bucket={b}
                  memberCount={members.length}
                  accounts={accounts}
                  collapsed={collapsed}
                  isSelected={selectedGroupId === b.id}
                  isDropTarget={dropTarget === bucketKey(b.id)}
                  accountLabel={accountLabel}
                  onToggleCollapse={() => toggleGroupCollapse(b.id)}
                  onSelect={() => selectGroup(b.id)}
                  onRename={(name) => b.id && void renameGroup(b.id, name)}
                  onSetAccount={(accountId) => b.id && void setGroupAccount(b.id, accountId)}
                  onRemove={() => b.id && void removeGroup(b.id)}
                  onAddSession={() => {
                    selectGroup(b.id)
                    void createSession('claude')
                  }}
                  onDragOver={(e) => {
                    if (dragId) {
                      e.preventDefault()
                      setDropTarget(bucketKey(b.id))
                    }
                  }}
                  onDragLeave={() => setDropTarget((t) => (t === bucketKey(b.id) ? null : t))}
                  onDrop={(e) => {
                    e.preventDefault()
                    if (dragId) moveSessionToGroup(dragId, b.id)
                    setDragId(null)
                    setDropTarget(null)
                  }}
                />

                {!collapsed && (
                  <ul className="mb-1 ml-2 space-y-0.5 border-l border-line pl-1.5">
                    {members.length === 0 && (
                      <li className="px-2 py-1 text-[11px] text-txt-dim">（空，拖 session 到此）</li>
                    )}
                    {members.map((s) => (
                      <SessionRow
                        key={s.id}
                        session={s}
                        defaultLabel={`${PROVIDER_UI[s.provider].label} #${numberOf.get(s.id)}`}
                        customName={sessionName[s.id]}
                        isActive={view === 'terminal' && s.id === activeId}
                        busy={sessionBusy[s.id] ?? false}
                        attention={s.id in attention}
                        onSelect={() => setActive(s.id)}
                        onRename={(name) => renameSession(s.id, name)}
                        onClose={() => closeSession(s.id)}
                        onDragStart={() => setDragId(s.id)}
                        onDragEnd={() => {
                          setDragId(null)
                          setDropTarget(null)
                        }}
                      />
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <AddonNav currentAccount={currentAccount} />
    </aside>
  )
}
