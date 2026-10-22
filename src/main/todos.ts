import { app } from 'electron'
import { readFileSync, unwatchFile, watchFile, type Stats } from 'node:fs'
import { join } from 'node:path'
import type { TodoItem } from '../shared/types'
import { writeFileAtomic } from './atomic-write'

// Daily to-do list, persisted as one plain JSON file in userData.
//
// The format is deliberately simple and flat — a single `items` array with a
// `date` field rather than a map keyed by date — because a Claude Code session
// is expected to append to this file directly (see the `daily-todos` skill).
// A shape that is obvious to hand-edit is worth more here than one that is
// marginally tidier to query, and everything is normalized on read so a
// hand-written entry missing a field can never break the panel.

interface TodoFile {
  version: 1
  items: TodoItem[]
}

const EMPTY: TodoFile = { version: 1, items: [] }

export function todosPath(): string {
  return join(app.getPath('userData'), 'todos.json')
}

/** Local calendar date as YYYY-MM-DD — never UTC, or "today" flips at 8am here. */
export function todayKey(now = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Coerce one entry into a usable item, or null to drop it.
 *
 * Anything here may have been typed by hand into the JSON, so every field is
 * checked and defaulted rather than trusted.
 */
function normalize(raw: unknown, index: number): TodoItem | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Partial<TodoItem>
  const text = typeof o.text === 'string' ? o.text.trim() : ''
  if (!text) return null
  return {
    id: typeof o.id === 'string' && o.id ? o.id : `t${Date.now().toString(36)}${index}`,
    date: typeof o.date === 'string' && DATE_RE.test(o.date) ? o.date : todayKey(),
    text,
    done: o.done === true,
    note: typeof o.note === 'string' ? o.note : undefined,
    source: o.source === 'claude' ? 'claude' : 'app',
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : Date.now()
  }
}

let cache: TodoFile | null = null

function load(): TodoFile {
  if (cache) return cache
  try {
    const parsed = JSON.parse(readFileSync(todosPath(), 'utf8')) as Partial<TodoFile>
    const items = Array.isArray(parsed.items)
      ? parsed.items.map(normalize).filter((t): t is TodoItem => t !== null)
      : []
    cache = { version: 1, items }
  } catch {
    // Missing or unreadable: start empty rather than failing the panel. Unlike
    // ~/.claude/settings.json this file is ours, so there is nothing of the
    // user's to destroy by starting over.
    cache = { ...EMPTY, items: [] }
  }
  return cache
}

/**
 * Ignore watcher events caused by our own writes.
 *
 * Without this every save bounces back through the file watcher as an
 * "external change" and refreshes the panel underneath whatever the user is
 * currently typing.
 */
let selfWriteUntil = 0

function persist(next: TodoFile): TodoFile {
  cache = next
  selfWriteUntil = Date.now() + 700
  try {
    writeFileAtomic(todosPath(), JSON.stringify(next, null, 2))
  } catch {
    /* best-effort; the in-memory copy still serves this run */
  }
  return next
}

/** Drop the cache so the next read comes from disk (used by the watcher). */
export function invalidateTodos(): void {
  cache = null
}

export function listTodos(): TodoItem[] {
  // Newest first within a day, oldest days last — the panel groups by date.
  return [...load().items].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt)
}

/** Append one or more to-dos for a date (defaults to today). */
export function addTodos(texts: string[], date = todayKey(), source: TodoItem['source'] = 'app'): TodoItem[] {
  const store = load()
  const clean = texts.map((t) => String(t ?? '').trim()).filter(Boolean)
  const now = Date.now()
  const added: TodoItem[] = clean.map((text, i) => ({
    id: `t${now.toString(36)}${Math.random().toString(36).slice(2, 6)}${i}`,
    date: DATE_RE.test(date) ? date : todayKey(),
    text,
    done: false,
    source,
    createdAt: now + i
  }))
  persist({ ...store, items: [...store.items, ...added] })
  return listTodos()
}

export function setTodoDone(id: string, done: boolean): TodoItem[] {
  const store = load()
  persist({ ...store, items: store.items.map((t) => (t.id === id ? { ...t, done: !!done } : t)) })
  return listTodos()
}

export function updateTodoText(id: string, text: string): TodoItem[] {
  const store = load()
  const clean = String(text ?? '').trim()
  if (!clean) return listTodos()
  persist({ ...store, items: store.items.map((t) => (t.id === id ? { ...t, text: clean } : t)) })
  return listTodos()
}

export function removeTodo(id: string): TodoItem[] {
  const store = load()
  persist({ ...store, items: store.items.filter((t) => t.id !== id) })
  return listTodos()
}

/** Clear every finished item, whatever day it belongs to. */
export function clearDoneTodos(): TodoItem[] {
  const store = load()
  persist({ ...store, items: store.items.filter((t) => !t.done) })
  return listTodos()
}

/**
 * Watch the file for changes made outside the app — that is how a Claude
 * session's edits show up without the user having to hit refresh.
 *
 * Uses stat polling (`watchFile`) rather than `fs.watch`. The event-based API
 * proved unreliable here: it needs the returned FSWatcher kept alive, it can
 * lose the inode when an atomic write renames a new file over the old one,
 * and on Windows the events for a single small file simply did not arrive in
 * testing. Polling once a second costs nothing for one small file and always
 * works — including before the file has been created for the first time.
 */
export function watchTodos(onChange: () => void): () => void {
  const path = todosPath()

  const onStat = (curr: Stats, prev: Stats): void => {
    // mtimeMs 0 means "still absent"; ignore until it actually appears.
    if (curr.mtimeMs === 0) return
    if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return
    if (Date.now() < selfWriteUntil) return
    invalidateTodos()
    onChange()
  }

  watchFile(path, { interval: 1000 }, onStat)
  return () => unwatchFile(path, onStat)
}
