import { useEffect, useMemo, useState } from 'react'
import type { KnowledgeEntry } from '@shared/types'
import { LibraryHeader } from './LibraryHeader'
import { useLoadable } from '../hooks/useLoadable'

type Kind = KnowledgeEntry['kind']
type Fields = Partial<Pick<KnowledgeEntry, 'kind' | 'title' | 'content' | 'dbFile' | 'dbPath' | 'tags'>>

function formatDate(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

function parseTags(text: string): string[] {
  return [...new Set(text.split(/[,，]/).map((t) => t.trim()).filter(Boolean))]
}

/** The add/edit form. Shared between the two kinds — only the field set and labels differ. */
function EntryForm({
  kind,
  initial,
  onCancel,
  onSave
}: {
  kind: Kind
  initial?: KnowledgeEntry
  onCancel: () => void
  onSave: (fields: Fields) => void
}): JSX.Element {
  const [title, setTitle] = useState(initial?.title ?? '')
  const [dbFile, setDbFile] = useState(initial?.dbFile ?? '')
  const [dbPath, setDbPath] = useState(initial?.dbPath ?? '')
  const [content, setContent] = useState(initial?.content ?? '')
  const [tagsText, setTagsText] = useState(initial?.tags.join(', ') ?? '')

  const canSave = kind === 'db' ? dbFile.trim() !== '' : title.trim() !== '' || content.trim() !== ''

  const save = (): void => {
    if (!canSave) return
    onSave({
      kind,
      title: kind === 'db' ? dbFile : title,
      content,
      dbFile: kind === 'db' ? dbFile : undefined,
      dbPath: kind === 'db' ? dbPath : undefined,
      tags: parseTags(tagsText)
    })
  }

  return (
    <div className="space-y-2 rounded-lg border border-copilot bg-bg-panel p-3">
      {kind === 'db' ? (
        <>
          <input
            autoFocus
            value={dbFile}
            onChange={(e) => setDbFile(e.target.value)}
            placeholder="資料庫檔名，例如 ort_test.db"
            className="w-full rounded border border-line bg-bg-base px-2 py-1.5 text-sm font-medium outline-none focus:border-copilot"
          />
          <input
            value={dbPath}
            onChange={(e) => setDbPath(e.target.value)}
            placeholder="路徑（選填，預設跟 knowledge.json 放一起）"
            className="w-full rounded border border-line bg-bg-base px-2 py-1.5 text-xs outline-none focus:border-copilot"
          />
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={8}
            placeholder="Schema / 用途說明——表名、欄位、用來記什麼"
            className="w-full resize-y rounded border border-line bg-bg-base px-2 py-1.5 font-mono text-xs leading-relaxed outline-none focus:border-copilot"
          />
        </>
      ) : (
        <>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="標題"
            className="w-full rounded border border-line bg-bg-base px-2 py-1.5 text-sm font-medium outline-none focus:border-copilot"
          />
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={8}
            placeholder="內容——筆記、心得、踩過的坑都可以"
            className="w-full resize-y rounded border border-line bg-bg-base px-2 py-1.5 text-sm leading-relaxed outline-none focus:border-copilot"
          />
        </>
      )}
      <input
        value={tagsText}
        onChange={(e) => setTagsText(e.target.value)}
        placeholder="標籤，逗號分隔（選填）"
        className="w-full rounded border border-line bg-bg-base px-2 py-1.5 text-xs outline-none focus:border-copilot"
      />
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="rounded-md px-3 py-1.5 text-xs text-txt-dim hover:bg-bg-hover">
          取消
        </button>
        <button
          onClick={save}
          disabled={!canSave}
          className="rounded-md bg-copilot px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          儲存
        </button>
      </div>
    </div>
  )
}

function KnowledgeCard({
  entry,
  onUpdate,
  onRemove
}: {
  entry: KnowledgeEntry
  onUpdate: (patch: Fields) => void
  onRemove: () => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [expanded, setExpanded] = useState(false)

  if (editing) {
    return (
      <li>
        <EntryForm
          kind={entry.kind}
          initial={entry}
          onCancel={() => setEditing(false)}
          onSave={(fields) => {
            onUpdate(fields)
            setEditing(false)
          }}
        />
      </li>
    )
  }

  return (
    <li className="group rounded-lg border border-line bg-bg-panel p-3">
      <div className="flex items-start gap-2">
        <button onClick={() => setExpanded((v) => !v)} className="min-w-0 flex-1 text-left">
          <div className="truncate text-sm font-medium text-txt-base">
            {entry.kind === 'db' ? entry.dbFile : entry.title}
          </div>
          {entry.kind === 'db' && entry.dbPath && (
            <div className="truncate text-[11px] text-txt-dim">{entry.dbPath}</div>
          )}
          {!expanded && entry.content && (
            <div className="mt-0.5 line-clamp-2 text-xs text-txt-dim">{entry.content}</div>
          )}
        </button>
        {entry.source === 'claude' && (
          <span
            title="由 Claude 寫入"
            className="shrink-0 rounded bg-bg-base px-1.5 py-0.5 text-[10px] text-txt-dim"
          >
            Claude
          </span>
        )}
        <span className="shrink-0 text-[11px] text-txt-dim">{formatDate(entry.updatedAt)}</span>
        <button
          onClick={() => setEditing(true)}
          title="編輯"
          className="hidden shrink-0 rounded px-1.5 text-xs text-txt-dim hover:bg-bg-base hover:text-txt-base group-hover:block"
        >
          編輯
        </button>
        <button
          onClick={onRemove}
          title="刪除"
          className="hidden shrink-0 rounded px-1.5 text-xs text-txt-dim hover:bg-bg-base hover:text-red-400 group-hover:block"
        >
          ✕
        </button>
      </div>

      {expanded && entry.content && (
        <div
          className={`mt-2 whitespace-pre-wrap border-t border-line pt-2 text-sm leading-relaxed text-txt-base ${
            entry.kind === 'db' ? 'font-mono text-xs' : ''
          }`}
        >
          {entry.content}
        </div>
      )}

      {entry.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {entry.tags.map((tag) => (
            <span key={tag} className="rounded bg-bg-base px-1.5 py-0.5 text-[10px] text-txt-dim">
              {tag}
            </span>
          ))}
        </div>
      )}
    </li>
  )
}

/**
 * 知識庫.
 *
 * A free-form notes/wiki store, same file-watching convention as 代辦事項: the
 * list lives in the main process as one JSON file, which a Claude Code
 * session also writes to (the `knowledge-capture` skill). The panel follows
 * the file rather than only trusting its own writes.
 *
 * Two kinds share the file, split by a tab: 筆記 (freeform lessons/SOPs) and
 * 資料庫索引 (a registry of the SQLite databases this machine maintains
 * alongside knowledge.json — schema and purpose, not prose). Keeping the
 * database registry as a distinct kind rather than just another tagged note
 * means its fields (filename, path, schema) can stay structured instead of
 * being buried inside a paragraph of narrative notes.
 */
export function KnowledgeLibrary(): JSX.Element {
  const { data: entries, loading, setData } = useLoadable<KnowledgeEntry[]>(
    () => window.api.listKnowledge(),
    []
  )
  const [filePath, setFilePath] = useState('')
  const [tab, setTab] = useState<Kind>('note')
  const [query, setQuery] = useState('')
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    void window.api.knowledgeFilePath().then(setFilePath)
  }, [])

  // Follow external edits (the skill writing the file) for as long as the panel is mounted.
  useEffect(() => window.api.onKnowledgeChanged(setData), [setData])

  // Older entries written before 'kind' existed default to 'note' on read (see
  // main/knowledge.ts's normalize), so nothing already captured disappears.
  const inTab = useMemo(() => entries.filter((e) => e.kind === tab), [entries, tab])
  const noteCount = useMemo(() => entries.filter((e) => e.kind === 'note').length, [entries])
  const dbCount = entries.length - noteCount

  const allTags = useMemo(() => {
    const set = new Set<string>()
    for (const e of inTab) for (const t of e.tags) set.add(t)
    return [...set].sort()
  }, [inTab])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return inTab.filter((e) => {
      if (activeTag && !e.tags.includes(activeTag)) return false
      if (!q) return true
      return (
        e.title.toLowerCase().includes(q) ||
        e.content.toLowerCase().includes(q) ||
        (e.dbFile ?? '').toLowerCase().includes(q) ||
        e.tags.some((t) => t.toLowerCase().includes(q))
      )
    })
  }, [inTab, query, activeTag])

  const switchTab = (next: Kind): void => {
    setTab(next)
    setQuery('')
    setActiveTag(null)
    setAdding(false)
  }

  const add = async (fields: Fields): Promise<void> => {
    setData(await window.api.addKnowledge(fields))
    setAdding(false)
  }

  return (
    <div className="flex h-full flex-col">
      <LibraryHeader>
        <span className="text-sm font-medium">知識庫</span>
        <div className="ml-2 flex gap-1 rounded-md border border-line p-0.5">
          <button
            onClick={() => switchTab('note')}
            className={`rounded px-2.5 py-1 text-xs ${
              tab === 'note' ? 'bg-copilot text-white' : 'text-txt-dim hover:bg-bg-hover'
            }`}
          >
            筆記（{noteCount}）
          </button>
          <button
            onClick={() => switchTab('db')}
            className={`rounded px-2.5 py-1 text-xs ${
              tab === 'db' ? 'bg-copilot text-white' : 'text-txt-dim hover:bg-bg-hover'
            }`}
          >
            資料庫索引（{dbCount}）
          </button>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜尋…"
          className="ml-auto w-56 rounded-md border border-line bg-bg-base px-3 py-1.5 text-sm outline-none focus:border-copilot"
        />
        <button
          onClick={() => setAdding((v) => !v)}
          className="rounded-md bg-copilot px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
        >
          新增
        </button>
      </LibraryHeader>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="max-w-2xl space-y-4">
          {adding && (
            <EntryForm kind={tab} onCancel={() => setAdding(false)} onSave={(fields) => void add(fields)} />
          )}

          {allTags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {allTags.map((tag) => (
                <button
                  key={tag}
                  onClick={() => setActiveTag((t) => (t === tag ? null : tag))}
                  className={`rounded-full border px-2.5 py-1 text-[11px] ${
                    activeTag === tag
                      ? 'border-copilot bg-copilot text-white'
                      : 'border-line text-txt-dim hover:bg-bg-hover'
                  }`}
                >
                  {tag}
                </button>
              ))}
            </div>
          )}

          {loading && <div className="text-sm text-txt-dim">載入中…</div>}
          {!loading && filtered.length === 0 && (
            <div className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-xs text-txt-dim">
              {inTab.length === 0
                ? tab === 'note'
                  ? '還沒有筆記。可以直接在上面新增，或在終端機裡請 Claude 幫你把心得寫進來。'
                  : '還沒有登記任何資料庫。新增一筆，記下檔名、路徑跟 schema。'
                : '沒有符合搜尋/標籤條件的項目。'}
            </div>
          )}

          <ul className="space-y-2">
            {filtered.map((entry) => (
              <KnowledgeCard
                key={entry.id}
                entry={entry}
                onUpdate={async (patch) => setData(await window.api.updateKnowledge(entry.id, patch))}
                onRemove={async () => setData(await window.api.removeKnowledge(entry.id))}
              />
            ))}
          </ul>

          {filePath && (
            <p className="border-t border-line pt-4 text-[11px] leading-relaxed text-txt-dim">
              資料存在 <code className="break-all">{filePath}</code>。
              <br />
              在終端機裡跟 Claude 講完要記下什麼之後，叫它用 <code>knowledge-capture</code> skill
              寫進來，這個畫面會自動更新。
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
