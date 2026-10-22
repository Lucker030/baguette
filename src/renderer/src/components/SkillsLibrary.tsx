import { useMemo, useState } from 'react'
import type { SkillInfo } from '@shared/types'
import { LibraryHeader } from './LibraryHeader'
import { useLoadable } from '../hooks/useLoadable'

export function SkillsLibrary(): JSX.Element {
  const { data: skills, loading, reload } = useLoadable<SkillInfo[]>(() => window.api.listSkills(), [])
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')

  const submitNew = async (): Promise<void> => {
    const name = newName.trim()
    if (!name) return
    const created = await window.api.createSkill(name, newDesc.trim())
    setCreating(false)
    setNewName('')
    setNewDesc('')
    await reload()
    setSelected(created.id)
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return skills
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.source.toLowerCase().includes(q)
    )
  }, [skills, query])

  const active = filtered.find((s) => s.id === selected) ?? null

  return (
    <div className="flex h-full flex-col">
      <LibraryHeader>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜尋 skills…"
          className="flex-1 rounded-md border border-line bg-bg-base px-3 py-1.5 text-sm outline-none focus:border-copilot"
        />
        <span className="text-xs text-txt-dim">{filtered.length} 個</span>
        <button
          onClick={() => setCreating(true)}
          className="rounded-md bg-copilot px-2.5 py-1.5 text-sm font-medium text-white hover:opacity-90"
          title="新增一個 skill"
        >
          ＋ 新增
        </button>
        <button
          onClick={() => void reload()}
          className="rounded-md border border-line px-2.5 py-1.5 text-sm text-txt-dim hover:bg-bg-hover hover:text-txt-base"
          title="重新整理"
        >
          ⟳
        </button>
      </LibraryHeader>

      {creating && (
        <div className="border-b border-line bg-bg-panel px-4 py-3">
          <div className="mb-2 text-sm font-medium">新增 Skill</div>
          <div className="space-y-2">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="名稱（例如 my-helper）"
              className="w-full rounded-md border border-line bg-bg-base px-3 py-1.5 text-sm outline-none focus:border-copilot"
            />
            <textarea
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              placeholder="描述：這個 skill 何時該被使用"
              rows={2}
              className="w-full resize-none rounded-md border border-line bg-bg-base px-3 py-1.5 text-sm outline-none focus:border-copilot"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={() => void submitNew()}
                disabled={!newName.trim()}
                className={`rounded-md px-4 py-1.5 text-sm font-medium ${
                  newName.trim()
                    ? 'bg-copilot text-white hover:opacity-90'
                    : 'cursor-not-allowed bg-bg-base text-txt-dim'
                }`}
              >
                建立
              </button>
              <button
                onClick={() => {
                  setCreating(false)
                  setNewName('')
                  setNewDesc('')
                }}
                className="rounded-md border border-line px-3 py-1.5 text-sm text-txt-dim hover:bg-bg-hover hover:text-txt-base"
              >
                取消
              </button>
              <span className="text-[11px] text-txt-dim">
                會建立在 <code>~/.claude/skills/</code> 下
              </span>
            </div>
          </div>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[1fr_1.2fr]">
        {/* List */}
        <div className="min-h-0 overflow-y-auto border-r border-line p-2">
          {loading && <div className="p-4 text-sm text-txt-dim">載入中…</div>}
          {!loading && filtered.length === 0 && (
            <div className="p-4 text-sm text-txt-dim">
              找不到 skills。預期位置：<code>~/.claude/skills</code>
            </div>
          )}
          <ul className="space-y-1">
            {filtered.map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => setSelected(s.id)}
                  className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                    selected === s.id
                      ? 'border-copilot/60 bg-bg-hover'
                      : 'border-transparent hover:bg-bg-elev'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{s.name}</span>
                    {!s.hasSkillMd && (
                      <span className="rounded bg-yellow-500/15 px-1.5 text-[10px] text-yellow-400">
                        無 SKILL.md
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 line-clamp-2 text-xs text-txt-dim">
                    {s.description || '（無描述）'}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* Detail */}
        <div className="min-h-0 overflow-y-auto p-5">
          {active ? (
            <div className="space-y-4">
              <div>
                <h2 className="text-base font-semibold">{active.name}</h2>
                <div className="mt-1 text-xs text-txt-dim">{active.source}</div>
              </div>
              <div>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-txt-dim">
                  描述
                </div>
                <p className="text-sm leading-relaxed">{active.description || '（無描述）'}</p>
              </div>
              <div>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-txt-dim">
                  路徑
                </div>
                <code className="block break-all rounded-md bg-bg-panel px-3 py-2 text-xs text-txt-base">
                  {active.path}
                </code>
              </div>
            </div>
          ) : (
            <div className="grid h-full place-items-center text-sm text-txt-dim">
              選擇左側一個 skill 查看詳情
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
