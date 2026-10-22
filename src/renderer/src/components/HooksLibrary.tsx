import { useState } from 'react'
import type { HookDef, HookEvent, HookSchedule } from '@shared/types'
import { HOOK_MATCHER_EVENTS } from '@shared/types'
import { LibraryHeader } from './LibraryHeader'
import { useLoadable } from '../hooks/useLoadable'
import { Toggle } from './Toggle'

const EVENTS: (HookEvent | 'Schedule')[] = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Notification',
  'Stop',
  'SubagentStop',
  'SessionStart',
  'SessionEnd',
  'Schedule'
]

const DAY_LABELS = ['日', '一', '二', '三', '四', '五', '六']

const BLANK: Omit<HookDef, 'id'> = {
  name: '',
  event: 'PreToolUse',
  matcher: '*',
  command: '',
  enabled: true,
  schedule: { time: '17:00', days: [1, 2, 3, 4, 5] }
}

function toggleDay(days: number[], d: number): number[] {
  return days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort()
}

function scheduleSummary(s?: HookSchedule): string {
  if (!s) return ''
  const days =
    s.days.length === 0 || s.days.length === 7 ? '每天' : s.days.map((d) => DAY_LABELS[d]).join('')
  return `${s.time} · ${days}`
}

export function HooksLibrary(): JSX.Element {
  const { data: hooks, loading, reload, setData: setHooks } = useLoadable<HookDef[]>(
    () => window.api.listHooks(),
    []
  )
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Omit<HookDef, 'id'>>(BLANK)
  const [creating, setCreating] = useState(false)

  const startCreate = (): void => {
    setDraft(BLANK)
    setCreating(true)
    setEditingId(null)
  }

  const startEdit = (h: HookDef): void => {
    setDraft({
      name: h.name,
      event: h.event,
      matcher: h.matcher,
      command: h.command,
      enabled: h.enabled,
      schedule: h.schedule ?? BLANK.schedule
    })
    setEditingId(h.id)
    setCreating(false)
  }

  const cancel = (): void => {
    setCreating(false)
    setEditingId(null)
    setDraft(BLANK)
  }

  const save = async (): Promise<void> => {
    if (!draft.command.trim() || !draft.name.trim()) return
    if (editingId) setHooks(await window.api.updateHook(editingId, draft))
    else setHooks(await window.api.createHook(draft))
    cancel()
  }

  const toggle = async (h: HookDef): Promise<void> => {
    setHooks(await window.api.setHookEnabled(h.id, !h.enabled))
  }

  const remove = async (id: string): Promise<void> => {
    setHooks(await window.api.removeHook(id))
    if (editingId === id) cancel()
  }

  const isSchedule = draft.event === 'Schedule'
  const showMatcher = !isSchedule && HOOK_MATCHER_EVENTS.includes(draft.event as HookEvent)
  const editorOpen = creating || editingId !== null

  return (
    <div className="flex h-full flex-col">
      <LibraryHeader>
        <span className="text-sm font-medium">Hook 庫</span>
        <span className="text-xs text-txt-dim">{hooks.length} 個</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={startCreate}
            className="rounded-md bg-copilot px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
          >
            ＋ 新增 Hook
          </button>
          <button
            onClick={() => void reload()}
            className="rounded-md border border-line px-2.5 py-1.5 text-sm text-txt-dim hover:bg-bg-hover hover:text-txt-base"
            title="重新整理"
          >
            ⟳
          </button>
        </div>
      </LibraryHeader>

      <div className="border-b border-line bg-bg-panel px-4 py-2 text-[11px] text-txt-dim">
        事件型 hook（PreToolUse 等）啟動後會寫進 <code>~/.claude/settings.json</code> 的{' '}
        <code>hooks</code>；Schedule 型則是建立一個 Windows 工作排程器任務，到點就執行，不需要
        Claude Code 或本 App 開著。關閉都會移除對應項目，只會動到本庫管理的項目。
      </div>

      {editorOpen && (
        <div className="border-b border-line bg-bg-panel px-4 py-3">
          <div className="mb-2 text-sm font-medium">{editingId ? '編輯 Hook' : '新增 Hook'}</div>
          <div className="grid max-w-3xl gap-2">
            <div className="flex gap-2">
              <input
                autoFocus
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="名稱（例如 format-on-save）"
                className="flex-1 rounded-md border border-line bg-bg-base px-3 py-1.5 text-sm outline-none focus:border-copilot"
              />
              <select
                value={draft.event}
                onChange={(e) =>
                  setDraft({ ...draft, event: e.target.value as HookEvent | 'Schedule' })
                }
                className="rounded-md border border-line bg-bg-base px-2 py-1.5 text-sm outline-none focus:border-copilot"
              >
                {EVENTS.map((ev) => (
                  <option key={ev} value={ev}>
                    {ev === 'Schedule' ? 'Schedule（時間排程）' : ev}
                  </option>
                ))}
              </select>
              {showMatcher && (
                <input
                  value={draft.matcher}
                  onChange={(e) => setDraft({ ...draft, matcher: e.target.value })}
                  placeholder="matcher，如 Bash、Edit|Write、*"
                  className="w-52 rounded-md border border-line bg-bg-base px-3 py-1.5 text-sm outline-none focus:border-copilot"
                />
              )}
            </div>
            {isSchedule && (
              <div className="flex items-center gap-3 rounded-md border border-line bg-bg-base px-3 py-2">
                <input
                  type="time"
                  value={draft.schedule?.time ?? '17:00'}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      schedule: { days: draft.schedule?.days ?? [], time: e.target.value }
                    })
                  }
                  className="rounded-md border border-line bg-bg-panel px-2 py-1 text-sm outline-none focus:border-copilot"
                />
                <div className="flex gap-1">
                  {DAY_LABELS.map((label, d) => {
                    const on = (draft.schedule?.days ?? []).includes(d)
                    return (
                      <button
                        key={d}
                        type="button"
                        onClick={() =>
                          setDraft({
                            ...draft,
                            schedule: {
                              time: draft.schedule?.time ?? '17:00',
                              days: toggleDay(draft.schedule?.days ?? [], d)
                            }
                          })
                        }
                        className={`h-6 w-6 rounded text-xs ${
                          on ? 'bg-copilot text-white' : 'border border-line text-txt-dim hover:bg-bg-hover'
                        }`}
                      >
                        {label}
                      </button>
                    )
                  })}
                </div>
                <span className="text-[11px] text-txt-dim">沒勾任何一天 = 每天</span>
              </div>
            )}
            <textarea
              value={draft.command}
              onChange={(e) => setDraft({ ...draft, command: e.target.value })}
              placeholder={
                isSchedule
                  ? '到點要執行的指令（會包成 .bat 執行，如 wsl bash -lc "..."）'
                  : '要執行的 shell 指令'
              }
              rows={2}
              className="w-full resize-y rounded-md border border-line bg-bg-base px-3 py-1.5 font-mono text-xs outline-none focus:border-copilot"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={() => void save()}
                disabled={!draft.name.trim() || !draft.command.trim()}
                className={`rounded-md px-4 py-1.5 text-sm font-medium ${
                  draft.name.trim() && draft.command.trim()
                    ? 'bg-copilot text-white hover:opacity-90'
                    : 'cursor-not-allowed bg-bg-base text-txt-dim'
                }`}
              >
                {editingId ? '儲存' : '建立'}
              </button>
              <button
                onClick={cancel}
                className="rounded-md border border-line px-3 py-1.5 text-sm text-txt-dim hover:bg-bg-hover hover:text-txt-base"
              >
                取消
              </button>
              <label className="ml-2 flex items-center gap-2 text-xs text-txt-dim">
                <Toggle on={draft.enabled} onChange={(v) => setDraft({ ...draft, enabled: v })} />
                建立後即啟動
              </label>
            </div>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {loading && <div className="p-4 text-sm text-txt-dim">載入中…</div>}
        {!loading && hooks.length === 0 && (
          <div className="p-4 text-sm text-txt-dim">
            還沒有 hook。按右上角「＋ 新增 Hook」建立一個。
          </div>
        )}
        <ul className="space-y-1.5">
          {hooks.map((h) => (
            <li
              key={h.id}
              className="flex items-center gap-3 rounded-lg border border-line bg-bg-panel px-3 py-2.5"
            >
              <Toggle on={h.enabled} onChange={() => void toggle(h)} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{h.name}</span>
                  <span className="rounded bg-bg-base px-1.5 py-0.5 text-[10px] text-txt-dim">
                    {h.event === 'Schedule'
                      ? scheduleSummary(h.schedule)
                      : h.event +
                        (HOOK_MATCHER_EVENTS.includes(h.event as HookEvent) && h.matcher
                          ? ` · ${h.matcher}`
                          : '')}
                  </span>
                  {!h.enabled && <span className="text-[10px] text-txt-dim">已關閉</span>}
                </div>
                <div className="mt-0.5 truncate font-mono text-[11px] text-txt-dim" title={h.command}>
                  {h.command || '（空指令）'}
                </div>
              </div>
              <button
                onClick={() => startEdit(h)}
                className="rounded border border-line px-2.5 py-1 text-xs text-txt-dim hover:bg-bg-hover hover:text-txt-base"
              >
                編輯
              </button>
              <button
                onClick={() => void remove(h.id)}
                className="rounded border border-line px-2 py-1 text-xs text-red-400 hover:bg-bg-base"
              >
                移除
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
