import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SyncAdapter, SyncChange } from './lan-sync'

// Storage behind LAN sync (lan-sync.ts): how each category lists, reads and
// writes its items. Knowledge entries and hooks are JSON records keyed by id;
// a skill is a whole folder under ~/.claude/skills keyed by folder name.

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** JSON with object keys sorted, so equal records hash equally. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v)
}

/** Copy keys for records: `<id>~<6 chars of the other PC's id>`. */
function recordCopyKey(key: string, fromId: string): string {
  return `${key}~${fromId.replace(/[^\w]/g, '').slice(0, 6)}`.slice(0, 80)
}

// ---- JSON records (knowledge, hooks) ----

export interface RecordStore<T extends { id: string }> {
  items(): T[]
  /** What counts as "the content" (e.g. a hook's enabled flag is local, not synced). */
  fingerprint(item: T): unknown
  write(put: unknown[], remove: string[]): void
  /** The record renamed for a conflict copy. */
  asCopy(item: T, copyKey: string, fromName: string): T
  /** Called before any write, to keep a backup of the file. */
  backup?(): void
}

export function recordAdapter<T extends { id: string }>(store: RecordStore<T>): SyncAdapter {
  const hashOf = (item: unknown): string => sha256(stable(store.fingerprint(item as T)))
  const current = (): Map<string, T> => new Map(store.items().map((i) => [i.id, i]))
  return {
    batch: 200,
    async manifest() {
      const out: Record<string, string> = {}
      for (const [id, item] of current()) out[id] = hashOf(item)
      return out
    },
    async read(keys) {
      const items = current()
      const out: Record<string, unknown> = {}
      for (const k of keys) if (items.has(k)) out[k] = items.get(k)
      return out
    },
    async apply(changes: SyncChange[]) {
      const items = current()
      const put: unknown[] = []
      const remove: string[] = []
      const ok = changes.map((c) => {
        const now = items.has(c.key) ? hashOf(items.get(c.key)) : null
        if (now !== c.expect) return false
        if (c.payload === null) remove.push(c.key)
        else if (typeof c.payload === 'object' && (c.payload as { id?: unknown }).id === c.key) put.push(c.payload)
        else return false
        return true
      })
      if (put.length || remove.length) {
        store.backup?.()
        store.write(put, remove)
      }
      return ok
    },
    hashOf,
    copyKey: (key, from) => recordCopyKey(key, from.id),
    asCopy: (payload, copyKey, from) => store.asCopy(payload as T, copyKey, from.name)
  }
}

/** Keep a timestamped copy of `file` in `dir`, at most `keep` of them. */
export function backupFile(file: string, dir: string, keep = 20): void {
  if (!existsSync(file)) return
  mkdirSync(dir, { recursive: true })
  const base = file.replace(/^.*[\\/]/, '').replace(/\.json$/, '')
  writeFileSync(join(dir, `${base}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), readFileSync(file))
  const mine = readdirSync(dir).filter((f) => f.startsWith(`${base}-`)).sort()
  for (const old of mine.slice(0, Math.max(0, mine.length - keep))) rmSync(join(dir, old), { force: true })
}

// ---- skills (folders) ----

/**
 * Copy each skill's SKILL.md from `src` into every AI's skill folder — what
 * ~/.agents/skills/install.ps1 does on the user's main PC, done here so a PC
 * that received skills by sync (and has no install.ps1) can use them too.
 * Scripts stay in `src`; the copies point back at them. Returns the names.
 */
export function distributeSkills(src: string, targets: string[]): string[] {
  if (!existsSync(src)) return []
  const names: string[] = []
  for (const name of readdirSync(src)) {
    const md = join(src, name, 'SKILL.md')
    if (name.startsWith('.') || !safeSegment(name) || !existsSync(md)) continue
    const st = lstatSync(join(src, name))
    if (!st.isDirectory() || st.isSymbolicLink()) continue
    for (const t of targets) {
      mkdirSync(join(t, name), { recursive: true })
      writeFileSync(join(t, name, 'SKILL.md'), readFileSync(md))
    }
    names.push(name)
  }
  return names
}

export const SKILL_LIMITS = { files: 500, fileBytes: 4 * 1024 * 1024, totalBytes: 5 * 1024 * 1024 }

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** One path segment that is safe as a Windows file or folder name. */
export function safeSegment(s: string): boolean {
  return (
    s.length > 0 &&
    s.length <= 120 &&
    s !== '.' &&
    s !== '..' &&
    // Windows-invalid characters, control characters included.
    // eslint-disable-next-line no-control-regex
    !/[<>:"/\\|?*\x00-\x1f]/.test(s) &&
    !/[. ]$/.test(s) &&
    !RESERVED.test(s)
  )
}

interface SkillFile {
  path: string
  data: string
}

/** The files of a skill sent to another PC: relative '/' paths and base64 bytes. */
interface SkillPayload {
  files: SkillFile[]
}

function skillHash(files: { path: string; sha: string }[]): string {
  return sha256(
    [...files]
      .sort((a, b) => (a.path < b.path ? -1 : 1))
      .map((f) => `${f.path}\0${f.sha}\n`)
      .join('')
  )
}

/** Throws (with a reason) unless every file is allowed. */
export function validateSkill(p: unknown): { path: string; bytes: Buffer }[] {
  const files = (p as SkillPayload | null)?.files
  if (!Array.isArray(files) || files.length === 0) throw new Error('沒有檔案')
  if (files.length > SKILL_LIMITS.files) throw new Error(`檔案超過 ${SKILL_LIMITS.files} 個`)
  const seen = new Set<string>()
  let total = 0
  return files.map((f) => {
    if (!f || typeof f.path !== 'string' || typeof f.data !== 'string') throw new Error('格式不對')
    const parts = f.path.split('/')
    if (!parts.every(safeSegment)) throw new Error(`不允許的路徑：${f.path}`)
    const lower = f.path.toLowerCase()
    if (seen.has(lower)) throw new Error(`大小寫重複的路徑：${f.path}`)
    seen.add(lower)
    const bytes = Buffer.from(f.data, 'base64')
    if (bytes.length > SKILL_LIMITS.fileBytes) throw new Error(`檔案太大：${f.path}`)
    total += bytes.length
    if (total > SKILL_LIMITS.totalBytes) throw new Error('skill 超過 5MB')
    return { path: f.path, bytes }
  })
}

/** Every file of a skill folder; throws on a link or anything over the limits. */
function scanSkill(dir: string): { path: string; abs: string; size: number }[] {
  const out: { path: string; abs: string; size: number }[] = []
  let total = 0
  const walk = (abs: string, rel: string): void => {
    for (const name of readdirSync(abs)) {
      const p = join(abs, name)
      const r = rel ? `${rel}/${name}` : name
      const st = lstatSync(p)
      if (st.isSymbolicLink()) throw new Error(`含有連結：${r}`)
      if (!safeSegment(name)) throw new Error(`不允許的檔名：${r}`)
      if (st.isDirectory()) walk(p, r)
      else if (st.isFile()) {
        if (st.size > SKILL_LIMITS.fileBytes) throw new Error(`檔案太大：${r}`)
        total += st.size
        if (total > SKILL_LIMITS.totalBytes) throw new Error('skill 超過 5MB')
        out.push({ path: r, abs: p, size: st.size })
        if (out.length > SKILL_LIMITS.files) throw new Error('檔案太多')
      }
    }
  }
  walk(dir, '')
  return out
}

/**
 * Skills under `root`, swapped as whole folders. A new version is written to
 * `work`/tmp, checked against the hash it should have, and only then renamed
 * into place; the folder it replaces (or a deleted one) is moved to
 * `work`/backup. `work` sits next to `root` so both renames stay on one disk.
 * A skill that breaks the rules (a link, a reserved name, too big) is left
 * out of the manifest and never touched.
 */
export function skillsAdapter(root: string, work: string, onSkip?: (name: string, reason: string) => void): SyncAdapter {
  const backupDir = join(work, 'backup')
  const tmpDir = join(work, 'tmp')

  const hashDir = (dir: string): string =>
    skillHash(scanSkill(dir).map((f) => ({ path: f.path, sha: sha256(readFileSync(f.abs)) })))

  const currentHash = (name: string): string | null => {
    const dir = join(root, name)
    if (!existsSync(dir)) return null
    return hashDir(dir)
  }

  const hashOf = (payload: unknown): string =>
    skillHash(validateSkill(payload).map((f) => ({ path: f.path, sha: sha256(f.bytes) })))

  const moveToBackup = (name: string): string => {
    mkdirSync(backupDir, { recursive: true })
    const to = join(backupDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}`)
    renameSync(join(root, name), to)
    const all = readdirSync(backupDir).sort()
    for (const old of all.slice(0, Math.max(0, all.length - 30))) rmSync(join(backupDir, old), { recursive: true, force: true })
    return to
  }

  const applyOne = (c: SyncChange): boolean => {
    if (!safeSegment(c.key) || c.key.startsWith('.')) return false
    let now: string | null
    try {
      now = currentHash(c.key)
    } catch {
      return false
    }
    if (now !== c.expect) return false
    if (c.payload === null) {
      if (now !== null) moveToBackup(c.key)
      return true
    }
    let files: { path: string; bytes: Buffer }[]
    try {
      files = validateSkill(c.payload)
    } catch (e) {
      onSkip?.(c.key, (e as Error).message)
      return false
    }
    const staging = join(tmpDir, randomBytes(6).toString('hex'))
    try {
      for (const f of files) {
        const p = join(staging, ...f.path.split('/'))
        mkdirSync(dirname(p), { recursive: true })
        writeFileSync(p, f.bytes)
      }
      if (hashDir(staging) !== hashOf(c.payload)) throw new Error('寫入後內容不符')
      mkdirSync(root, { recursive: true })
      const old = now !== null ? moveToBackup(c.key) : null
      try {
        renameSync(staging, join(root, c.key))
      } catch (e) {
        if (old) renameSync(old, join(root, c.key))
        throw e
      }
      return true
    } catch (e) {
      onSkip?.(c.key, (e as Error).message)
      rmSync(staging, { recursive: true, force: true })
      return false
    }
  }

  return {
    batch: 1,
    async manifest() {
      const out: Record<string, string> = {}
      if (!existsSync(root)) return out
      for (const name of readdirSync(root)) {
        // `synced` is Claude Code's own copy of claude.ai skills, with
        // per-PC state files (manifest.json, .last-complete-round); Claude
        // syncs it itself (seen 2026-10-25: it made every sync conflict).
        if (name.startsWith('.') || name === 'synced' || !safeSegment(name)) continue
        const dir = join(root, name)
        const st = lstatSync(dir)
        if (!st.isDirectory() || st.isSymbolicLink()) continue
        try {
          out[name] = hashDir(dir)
        } catch (e) {
          onSkip?.(name, (e as Error).message)
        }
      }
      return out
    },
    async read(keys) {
      const out: Record<string, unknown> = {}
      for (const name of keys) {
        if (!safeSegment(name) || !existsSync(join(root, name))) continue
        try {
          const files = scanSkill(join(root, name)).map((f) => ({ path: f.path, data: readFileSync(f.abs).toString('base64') }))
          out[name] = { files } satisfies SkillPayload
        } catch (e) {
          onSkip?.(name, (e as Error).message)
        }
      }
      return out
    },
    async apply(changes) {
      return changes.map(applyOne)
    },
    hashOf,
    copyKey: (key, from) => {
      // eslint-disable-next-line no-control-regex
      const tag = from.name.replace(/[<>:"/\\|?*\x00-\x1f\s]+/g, '-').replace(/[. -]+$/, '') || from.id.slice(0, 6)
      return `${key}-from-${tag}`.slice(0, 100).replace(/[. ]+$/, '')
    },
    asCopy: (payload, copyKey) => {
      // A copy keeps working as its own skill only with its own name.
      const p = payload as SkillPayload
      return {
        files: p.files.map((f) => {
          if (f.path !== 'SKILL.md') return f
          const md = Buffer.from(f.data, 'base64').toString('utf8').replace(/^name:.*$/m, `name: ${copyKey}`)
          return { path: f.path, data: Buffer.from(md, 'utf8').toString('base64') }
        })
      } satisfies SkillPayload
    }
  }
}
