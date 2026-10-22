import { useEffect, useMemo, useRef, useState } from 'react'
import type { TodoItem } from '@shared/types'
import { LibraryHeader } from './LibraryHeader'
import { useLoadable } from '../hooks/useLoadable'

/** Local calendar day as YYYY-MM-DD — must match main/todos.ts's todayKey. */
function todayKey(now = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

function dayLabel(date: string, today: string): string {
  if (date === today) return '今天'
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  const diff = Math.round((dt.getTime() - new Date(today).getTime()) / 86400000)
  const weekday = `週${WEEKDAYS[dt.getDay()]}`
  if (diff === -1) return `昨天 · ${weekday}`
  if (diff === 1) return `明天 · ${weekday}`
  return `${m}/${d} · ${weekday}`
}

function TodoRow({
  item,
  onToggle,
  onEdit,
  onRemove
}: {
  item: TodoItem
  onToggle: () => void
  onEdit: (text: string) => void
  onRemove: () => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.text)

  if (editing) {
    return (
      <li className="flex items-center gap-2 rounded-md border border-copilot bg-bg-panel px-3 py-2">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onEdit(draft)
              setEditing(false)
            }
            if (e.key === 'Escape') {
              setDraft(item.text)
              setEditing(false)
            }
          }}
          onBlur={() => {
            onEdit(draft)
            setEditing(false)
          }}
          className="flex-1 rounded border border-line bg-bg-base px-2 py-1 text-sm outline-none"
        />
      </li>
    )
  }

  return (
    <li className="group flex items-center gap-2 rounded-md border border-line bg-bg-panel px-3 py-2">
      <input
        type="checkbox"
        checked={item.done}
        onChange={onToggle}
        className="h-4 w-4 shrink-0 accent-copilot"
      />
      <div className="min-w-0 flex-1">
        <div
          onDoubleClick={() => {
            setDraft(item.text)
            setEditing(true)
          }}
          title="點兩下改內容"
          className={`truncate text-sm ${item.done ? 'text-txt-dim line-through' : 'text-txt-base'}`}
        >
          {item.text}
        </div>
        {item.note && <div className="mt-0.5 truncate text-[11px] text-txt-dim">{item.note}</div>}
      </div>
      {item.source === 'claude' && (
        <span
          title="由 Claude 指派"
          className="shrink-0 rounded bg-bg-base px-1.5 py-0.5 text-[10px] text-txt-dim"
        >
          Claude
        </span>
      )}
      <button
        onClick={onRemove}
        title="刪除"
        className="hidden shrink-0 rounded px-1.5 text-xs text-txt-dim hover:bg-bg-base hover:text-red-400 group-hover:block"
      >
        ✕
      </button>
    </li>
  )
}

/**
 * 每日代辦事項.
 *
 * The list lives in the main process as one JSON file, which a Claude Code
 * session also writes to (the `daily-todos` skill). The panel therefore
 * follows the file — an assignment made in a terminal tab shows up here
 * without a refresh — rather than only trusting its own writes.
 */
export function TodosPanel(): JSX.Element {
  const { data: todos, loading, setData } = useLoadable<TodoItem[]>(
    () => window.api.listTodos(),
    []
  )
  const [draft, setDraft] = useState('')
  const [filePath, setFilePath] = useState('')
  const today = todayKey()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void window.api.todosFilePath().then(setFilePath)
  }, [])

  // Follow external edits (the skill writing the file) for as long as the
  // panel is mounted.
  useEffect(() => window.api.onTodosChanged(setData), [setData])

  const { todayItems, olderByDate } = useMemo(() => {
    const todayItems = todos.filter((t) => t.date === today)
    const groups = new Map<string, TodoItem[]>()
    for (const t of todos) {
      if (t.date === today) continue
      groups.set(t.date, [...(groups.get(t.date) ?? []), t])
    }
    return { todayItems, olderByDate: [...groups.entries()] }
  }, [todos, today])

  const add = async (): Promise<void> => {
    // One per line, so a list pasted in at once becomes separate items.
    const lines = draft.split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length === 0) return
    setData(await window.api.addTodos(lines))
    setDraft('')
    inputRef.current?.focus()
  }

  const remaining = todayItems.filter((t) => !t.done).length
  const doneCount = todos.filter((t) => t.done).length

  return (
    <div className="flex h-full flex-col">
      <LibraryHeader>
        <span className="text-sm font-medium">代辦事項</span>
        <span className="text-xs text-txt-dim">
          今天還有 {remaining} 件{todayItems.length > 0 && ` / 共 ${todayItems.length} 件`}
        </span>
        {doneCount > 0 && (
          <button
            onClick={async () => setData(await window.api.clearDoneTodos())}
            className="ml-auto rounded-md border border-line px-2.5 py-1.5 text-sm text-txt-dim hover:bg-bg-hover hover:text-txt-base"
          >
            清除已完成（{doneCount}）
          </button>
        )}
      </LibraryHeader>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="max-w-2xl space-y-6">
          {/* Today first — that is what this panel is for. */}
          <section className="space-y-2">
            <h2 className="text-sm font-medium">今日代辦事項</h2>

            <div className="flex gap-2">
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void add()}
                placeholder="加一件今天要做的事，Enter 送出"
                className="flex-1 rounded-md border border-line bg-bg-base px-3 py-2 text-sm outline-none focus:border-copilot"
              />
              <button
                onClick={() => void add()}
                disabled={!draft.trim()}
                className={`rounded-md px-4 py-2 text-sm font-medium ${
                  draft.trim()
                    ? 'bg-copilot text-white hover:opacity-90'
                    : 'cursor-not-allowed bg-bg-panel text-txt-dim'
                }`}
              >
                新增
              </button>
            </div>

            {loading && <div className="text-sm text-txt-dim">載入中…</div>}
            {!loading && todayItems.length === 0 && (
              <div className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-xs text-txt-dim">
                今天還沒有代辦事項。可以直接在上面新增,
                <br />
                或在終端機裡請 Claude 幫你分配，它會直接寫進來。
              </div>
            )}

            <ul className="space-y-1.5">
              {todayItems.map((t) => (
                <TodoRow
                  key={t.id}
                  item={t}
                  onToggle={async () => setData(await window.api.setTodoDone(t.id, !t.done))}
                  onEdit={async (text) => setData(await window.api.updateTodoText(t.id, text))}
                  onRemove={async () => setData(await window.api.removeTodo(t.id))}
                />
              ))}
            </ul>
          </section>

          {olderByDate.map(([date, items]) => (
            <section key={date} className="space-y-2">
              <h2 className="text-sm font-medium text-txt-dim">
                {dayLabel(date, today)}
                <span className="ml-2 text-xs">
                  {items.filter((t) => !t.done).length} / {items.length} 未完成
                </span>
              </h2>
              <ul className="space-y-1.5">
                {items.map((t) => (
                  <TodoRow
                    key={t.id}
                    item={t}
                    onToggle={async () => setData(await window.api.setTodoDone(t.id, !t.done))}
                    onEdit={async (text) => setData(await window.api.updateTodoText(t.id, text))}
                    onRemove={async () => setData(await window.api.removeTodo(t.id))}
                  />
                ))}
              </ul>
            </section>
          ))}

          {filePath && (
            <p className="border-t border-line pt-4 text-[11px] leading-relaxed text-txt-dim">
              清單存在 <code className="break-all">{filePath}</code>。
              <br />
              在終端機裡跟 Claude 講完今天要做什麼之後,叫它用 <code>daily-todos</code> skill
              寫進來,這個畫面會自動更新。
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
