import { app } from 'electron'
import { readFileSync, unwatchFile, watchFile, type Stats } from 'node:fs'
import { join } from 'node:path'
import type { KnowledgeEntry } from '../shared/types'
import { writeFileAtomic } from './atomic-write'

// Knowledge base, persisted as one plain JSON file in userData. A Claude Code
// session is expected to append to this
// file directly (see the `knowledge-capture` skill), so the shape favours
// being obvious to hand-edit over being tidy to query, and everything is
// normalized on read so a hand-written entry missing a field can never break
// the panel.

interface KnowledgeFile {
  version: 1
  items: KnowledgeEntry[]
}

const EMPTY: KnowledgeFile = { version: 1, items: [] }

export function knowledgePath(): string {
  return join(app.getPath('userData'), 'knowledge.json')
}

/**
 * Coerce one entry into a usable item, or null to drop it.
 *
 * Anything here may have been typed by hand into the JSON, so every field is
 * checked and defaulted rather than trusted.
 */
function normalize(raw: unknown, index: number): KnowledgeEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Partial<KnowledgeEntry>
  const content = typeof o.content === 'string' ? o.content.trim() : ''
  const title = typeof o.title === 'string' ? o.title.trim() : ''
  const dbFile = typeof o.dbFile === 'string' ? o.dbFile.trim() : ''
  if (!content && !title && !dbFile) return null
  const now = Date.now()
  return {
    id: typeof o.id === 'string' && o.id ? o.id : `k${now.toString(36)}${index}`,
    kind: o.kind === 'db' ? 'db' : 'note',
    title: title || dbFile || content.slice(0, 40),
    content,
    dbFile: dbFile || undefined,
    dbPath: typeof o.dbPath === 'string' && o.dbPath.trim() ? o.dbPath.trim() : undefined,
    tags: Array.isArray(o.tags)
      ? [...new Set(o.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim()))]
      : [],
    source: o.source === 'claude' ? 'claude' : 'app',
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : now,
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : now
  }
}

/** Fields callers may set when adding or editing an entry. */
type KnowledgeFields = Partial<
  Pick<KnowledgeEntry, 'kind' | 'title' | 'content' | 'dbFile' | 'dbPath' | 'tags'>
>

function cleanTags(tags: string[] | undefined): string[] {
  return tags ? [...new Set(tags.map((t) => String(t ?? '').trim()).filter(Boolean))] : []
}

let cache: KnowledgeFile | null = null

function load(): KnowledgeFile {
  if (cache) return cache
  try {
    const parsed = JSON.parse(readFileSync(knowledgePath(), 'utf8')) as Partial<KnowledgeFile>
    const items = Array.isArray(parsed.items)
      ? parsed.items.map(normalize).filter((k): k is KnowledgeEntry => k !== null)
      : []
    cache = { version: 1, items }
  } catch {
    // Missing or unreadable: start empty rather than failing the panel. This
    // file is ours, so there is nothing of the user's to destroy by starting over.
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

function persist(next: KnowledgeFile): KnowledgeFile {
  cache = next
  selfWriteUntil = Date.now() + 700
  try {
    writeFileAtomic(knowledgePath(), JSON.stringify(next, null, 2))
  } catch {
    /* best-effort; the in-memory copy still serves this run */
  }
  return next
}

/** Drop the cache so the next read comes from disk (used by the watcher). */
export function invalidateKnowledge(): void {
  cache = null
}

export function listKnowledge(): KnowledgeEntry[] {
  // Most recently touched first — a wiki surfaces what was just added or edited.
  return [...load().items].sort((a, b) => b.updatedAt - a.updatedAt)
}

export function addKnowledge(
  fields: KnowledgeFields,
  source: KnowledgeEntry['source'] = 'app'
): KnowledgeEntry[] {
  const store = load()
  const content = String(fields.content ?? '').trim()
  const title = String(fields.title ?? '').trim()
  const dbFile = String(fields.dbFile ?? '').trim()
  if (!content && !title && !dbFile) return listKnowledge()
  const now = Date.now()
  const entry: KnowledgeEntry = {
    id: `k${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    kind: fields.kind === 'db' ? 'db' : 'note',
    title: title || dbFile || content.slice(0, 40),
    content,
    dbFile: dbFile || undefined,
    dbPath: fields.dbPath?.trim() || undefined,
    tags: cleanTags(fields.tags),
    source,
    createdAt: now,
    updatedAt: now
  }
  persist({ ...store, items: [...store.items, entry] })
  return listKnowledge()
}

export function updateKnowledge(id: string, patch: KnowledgeFields): KnowledgeEntry[] {
  const store = load()
  const now = Date.now()
  persist({
    ...store,
    items: store.items.map((k) => {
      if (k.id !== id) return k
      const kind = patch.kind !== undefined ? (patch.kind === 'db' ? 'db' : 'note') : k.kind
      const title = patch.title !== undefined ? patch.title.trim() : k.title
      const content = patch.content !== undefined ? patch.content.trim() : k.content
      const dbFile = patch.dbFile !== undefined ? patch.dbFile.trim() || undefined : k.dbFile
      const dbPath = patch.dbPath !== undefined ? patch.dbPath.trim() || undefined : k.dbPath
      const tags = patch.tags !== undefined ? cleanTags(patch.tags) : k.tags
      return {
        ...k,
        kind,
        title: title || dbFile || content.slice(0, 40) || k.title,
        content,
        dbFile,
        dbPath,
        tags,
        updatedAt: now
      }
    })
  })
  return listKnowledge()
}

/** LAN sync (lan-sync-adapters.ts): every entry as stored, read fresh from disk. */
export function knowledgeItems(): KnowledgeEntry[] {
  cache = null
  return load().items
}

/**
 * LAN sync: write and delete whole entries by id in one save. Entries come
 * from another PC, so each goes through normalize() like a hand-written one;
 * the id is kept as given (it is the sync key).
 */
export function applyKnowledgeChanges(put: unknown[], remove: string[]): void {
  const store = load()
  const byId = new Map(store.items.map((k) => [k.id, k]))
  for (const id of remove) byId.delete(id)
  put.forEach((raw, i) => {
    const entry = normalize(raw, i)
    if (entry && typeof (raw as { id?: unknown }).id === 'string') byId.set(entry.id, entry)
  })
  persist({ ...store, items: [...byId.values()] })
}

export function removeKnowledge(id: string): KnowledgeEntry[] {
  const store = load()
  persist({ ...store, items: store.items.filter((k) => k.id !== id) })
  return listKnowledge()
}

/**
 * Watch the file for changes made outside the app — that is how a Claude
 * session's captured knowledge shows up without the user having to hit
 * refresh.
 *
 * Uses stat polling (`watchFile`) rather than `fs.watch`. The event-based API
 * proved unreliable here: it needs the returned FSWatcher kept alive, it can
 * lose the inode when an atomic write renames a new file over the old one,
 * and on Windows the events for a single small file simply did not arrive in
 * testing. Polling once a second costs nothing for one small file and always
 * works — including before the file has been created for the first time.
 */
export function watchKnowledge(onChange: () => void): () => void {
  const path = knowledgePath()

  const onStat = (curr: Stats, prev: Stats): void => {
    if (curr.mtimeMs === 0) return
    if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return
    if (Date.now() < selfWriteUntil) return
    invalidateKnowledge()
    onChange()
  }

  watchFile(path, { interval: 1000 }, onStat)
  return () => unwatchFile(path, onStat)
}
