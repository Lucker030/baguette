import { EventEmitter } from 'node:events'
import type { LanSyncProgress, SyncCategory } from '../shared/types'
import { SYNC_CATEGORIES } from '../shared/types'

// Syncing 知識庫 / Skills / Hook 庫 between two paired PCs (lan.ts carries the
// calls). Designed with a review by Codex; the rules that matter:
//
// - A category syncs only while BOTH PCs ticked it for each other. The PC
//   receiving a call checks its own tick on every call, so unticking stops a
//   sync mid-way.
// - One PC plans: the one with the smaller device id (the coordinator). It
//   keeps, per peer and category, the hashes both sides agreed on last time
//   (the base), and merges three-way against it:
//     changed on one side          → copy it over
//     changed differently on both  → keep both: the coordinator's version
//                                    keeps the key, the other is stored on
//                                    both sides under a copy key
//     deleted on one side, untouched on the other → delete; deleted vs edited
//                                    → the edit wins
//   No base yet (first sync) → nothing is deleted, only copied. Timestamps are
//   never used to pick a winner: clocks differ and copying a file changes it.
// - Every write says what it expects to replace (a hash, or null for "not
//   there"); an item that changed since planning is skipped and its base
//   entry left alone, so the next round looks at it again.
// - A category syncs with one PC at a time: with three, pairwise bases can
//   resurrect deletions.
//
// No Electron imports; adapters (lan-sync-adapters.ts) do the storage.

export interface SyncChange {
  key: string
  /** null deletes. */
  payload: unknown | null
  /** Hash the item must have now, or null if it must not exist. */
  expect: string | null
}

export interface SyncAdapter {
  /** key → hash of every local item. */
  manifest(): Promise<Record<string, string>>
  read(keys: string[]): Promise<Record<string, unknown>>
  /** Validates and applies each change; false for one skipped (changed meanwhile, or invalid). */
  apply(changes: SyncChange[]): Promise<boolean[]>
  hashOf(payload: unknown): string
  /** The key a conflicting copy from `from` is stored under. */
  copyKey(key: string, from: { id: string; name: string }): string
  /** The payload as that copy (renamed so both can live side by side). */
  asCopy(payload: unknown, copyKey: string, from: { id: string; name: string }): unknown
  /** Keys fetched per read call (big items one at a time). */
  batch: number
}

export type Hashes = Record<string, string>

export type Op =
  | { kind: 'pull'; key: string }
  | { kind: 'push'; key: string }
  | { kind: 'delLocal'; key: string }
  | { kind: 'delRemote'; key: string }
  | { kind: 'conflict'; key: string }

/** The three-way merge, as a list of operations. `base` null = never synced. */
export function plan(local: Hashes, remote: Hashes, base: Hashes | null): Op[] {
  const ops: Op[] = []
  const keys = new Set([...Object.keys(local), ...Object.keys(remote)])
  for (const key of [...keys].sort()) {
    const l = local[key]
    const r = remote[key]
    if (l === r) continue
    const b = base?.[key]
    if (l === undefined) {
      // Only the other side has it: deleted here since the last sync, or new there.
      ops.push(b !== undefined && r === b ? { kind: 'delRemote', key } : { kind: 'pull', key })
    } else if (r === undefined) {
      ops.push(b !== undefined && l === b ? { kind: 'delLocal', key } : { kind: 'push', key })
    } else if (b !== undefined && l === b) {
      ops.push({ kind: 'pull', key })
    } else if (b !== undefined && r === b) {
      ops.push({ kind: 'push', key })
    } else {
      ops.push({ kind: 'conflict', key })
    }
  }
  return ops
}

/** The new base: what both sides now agree on, plus the old entry for anything still unsettled. */
export function nextBase(local: Hashes, remote: Hashes, old: Hashes | null): Hashes {
  const out: Hashes = {}
  for (const key of new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(old ?? {})])) {
    if (local[key] !== undefined && local[key] === remote[key]) out[key] = local[key]
    else if (old?.[key] !== undefined && (local[key] !== undefined || remote[key] !== undefined)) out[key] = old[key]
  }
  return out
}

// ---- the coordinator / responder ----

export interface SyncPeer {
  id: string
  name: string
  online: boolean
  /** What this PC ticked for the peer. */
  mine: Partial<Record<SyncCategory, boolean>>
  /** What the peer last said it ticked for this PC. */
  theirs: Partial<Record<SyncCategory, boolean>>
}

export interface SyncDeps {
  myId: () => string
  peers(): SyncPeer[]
  /** Persist this PC's ticks / what the peer told us. */
  setMine(peerId: string, cat: SyncCategory, on: boolean): void
  setTheirs(peerId: string, flags: Partial<Record<SyncCategory, boolean>>): void
  /** A call to the peer over the LAN session. */
  request(peerId: string, method: string, params: unknown): Promise<unknown>
  adapters: Record<SyncCategory, SyncAdapter>
  bases: { get(peerId: string, cat: SyncCategory): Hashes | null; set(peerId: string, cat: SyncCategory, base: Hashes): void }
  log: { info(m: string): void; warn(m: string): void }
}

const AUTO_MS = 60_000

export class SyncError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export class LanSync extends EventEmitter {
  private running = new Map<string, Promise<void>>()
  private progress = new Map<string, LanSyncProgress>()
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly deps: SyncDeps) {
    super()
  }

  start(): void {
    this.timer ??= setInterval(() => this.tick(), AUTO_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  progressOf(peerId: string): LanSyncProgress | undefined {
    return this.progress.get(peerId)
  }

  private isCoordinator(peerId: string): boolean {
    return this.deps.myId() < peerId
  }

  /** Both PCs ticked it. */
  private active(p: SyncPeer, cat: SyncCategory): boolean {
    return p.mine[cat] === true && p.theirs[cat] === true
  }

  /** Every minute: re-sync whatever is active with online peers (coordinator only). */
  tick(): void {
    for (const p of this.deps.peers()) {
      if (p.online && this.isCoordinator(p.id) && SYNC_CATEGORIES.some((c) => this.active(p, c))) void this.syncPeer(p.id)
    }
  }

  /** The user ticked or unticked a category for a peer. */
  async setEnabled(peerId: string, cat: SyncCategory, on: boolean): Promise<void> {
    if (on) {
      const other = this.deps.peers().find((p) => p.id !== peerId && p.mine[cat])
      if (other) throw new SyncError(409, `這一類已經在和「${other.name}」同步（一次只能和一台）`)
    }
    this.deps.setMine(peerId, cat, on)
    const me = this.deps.peers().find((p) => p.id === peerId)
    if (!me) return
    try {
      await this.deps.request(peerId, 'sync.prefs', { flags: me.mine })
    } catch (e) {
      this.deps.log.warn(`sync: could not tell ${me.name} about the change: ${(e as Error).message}`)
    }
    if (on && this.isCoordinator(peerId) && this.active(this.peer(peerId), cat)) void this.syncPeer(peerId)
  }

  private peer(id: string): SyncPeer {
    const p = this.deps.peers().find((x) => x.id === id)
    if (!p) throw new SyncError(404, '沒有這台裝置')
    return p
  }

  /** Calls from a paired PC (lan.ts routes `sync.*` here). */
  async serve(peerId: string, method: string, params: unknown): Promise<unknown> {
    const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>
    if (method === 'sync.prefs') {
      const flags: Partial<Record<SyncCategory, boolean>> = {}
      const raw = (p.flags ?? {}) as Record<string, unknown>
      for (const c of SYNC_CATEGORIES) if (typeof raw[c] === 'boolean') flags[c] = raw[c] as boolean
      this.deps.setTheirs(peerId, flags)
      this.emit('changed')
      // The coordinator starts as soon as both sides agree.
      if (this.isCoordinator(peerId)) void this.syncPeer(peerId)
      return { flags: this.peer(peerId).mine }
    }
    if (method === 'sync.progress') {
      const pr = p as unknown as LanSyncProgress
      this.setProgress(peerId, {
        category: SYNC_CATEGORIES.find((c) => c === pr.category) ?? 'knowledge',
        phase: pr.phase === 'done' || pr.phase === 'error' || pr.phase === 'scan' ? pr.phase : 'transfer',
        done: Number(pr.done) || 0,
        total: Number(pr.total) || 0,
        error: typeof pr.error === 'string' ? pr.error.slice(0, 300) : undefined,
        at: Date.now()
      })
      return {}
    }
    const cat = SYNC_CATEGORIES.find((c) => c === p.category)
    if (!cat) throw new SyncError(400, 'unknown category')
    // The gate: this PC's own tick, checked on every call.
    if (this.peer(peerId).mine[cat] !== true) throw new SyncError(403, '對方沒有勾選同步這一類')
    const adapter = this.deps.adapters[cat]
    if (method === 'sync.manifest') return adapter.manifest()
    if (method === 'sync.read') {
      const keys = Array.isArray(p.keys) ? p.keys.filter((k): k is string => typeof k === 'string').slice(0, 500) : []
      return adapter.read(keys)
    }
    if (method === 'sync.apply') {
      const changes = Array.isArray(p.changes) ? (p.changes as SyncChange[]).slice(0, 500) : []
      const clean = changes
        .filter((c) => c && typeof c.key === 'string')
        .map((c) => ({ key: c.key, payload: c.payload ?? null, expect: typeof c.expect === 'string' ? c.expect : null }))
      const ok = await adapter.apply(clean)
      if (ok.length) this.emit('applied', cat)
      return ok
    }
    throw new SyncError(404, `unknown method ${method}`)
  }

  /** One sync run with a peer over every active category; runs never overlap. */
  syncPeer(peerId: string): Promise<void> {
    const existing = this.running.get(peerId)
    if (existing) return existing
    const run = this.runPeer(peerId).finally(() => this.running.delete(peerId))
    this.running.set(peerId, run)
    return run
  }

  private async runPeer(peerId: string): Promise<void> {
    for (const cat of SYNC_CATEGORIES) {
      const p = this.peer(peerId)
      if (!this.active(p, cat) || !p.online) continue
      try {
        await this.syncCategory(p, cat)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        this.deps.log.warn(`sync ${cat} with ${p.name}: ${message}`)
        this.report(peerId, { category: cat, phase: 'error', done: 0, total: 0, error: message, at: Date.now() })
        return
      }
    }
  }

  private setProgress(peerId: string, pr: LanSyncProgress): void {
    this.progress.set(peerId, pr)
    this.emit('changed')
  }

  /** Show progress here and on the peer. */
  private report(peerId: string, pr: LanSyncProgress): void {
    this.setProgress(peerId, pr)
    void this.deps.request(peerId, 'sync.progress', pr).catch(() => {})
  }

  private async syncCategory(p: SyncPeer, cat: SyncCategory): Promise<void> {
    const adapter = this.deps.adapters[cat]
    const call = (method: string, params: Record<string, unknown>): Promise<unknown> =>
      this.deps.request(p.id, method, { category: cat, ...params })
    const them = { id: p.id, name: p.name }

    this.report(p.id, { category: cat, phase: 'scan', done: 0, total: 0, at: Date.now() })
    const local = await adapter.manifest()
    const remote = (await call('sync.manifest', {})) as Hashes
    const base = this.deps.bases.get(p.id, cat)
    const ops = plan(local, remote, base)
    const total = ops.length
    let done = 0
    let failed = 0
    const step = (ok: boolean): void => {
      done++
      if (!ok) failed++
      this.report(p.id, { category: cat, phase: 'transfer', done, total, at: Date.now() })
    }

    // What each side's items are, fetched in batches.
    const fetch = async (side: 'local' | 'remote', keys: string[]): Promise<Record<string, unknown>> => {
      const out: Record<string, unknown> = {}
      for (let i = 0; i < keys.length; i += adapter.batch) {
        const part = keys.slice(i, i + adapter.batch)
        Object.assign(out, side === 'local' ? await adapter.read(part) : ((await call('sync.read', { keys: part })) as Record<string, unknown>))
      }
      return out
    }
    const applyRemote = async (changes: SyncChange[]): Promise<boolean[]> => (await call('sync.apply', { changes })) as boolean[]

    for (const op of ops) {
      const { key } = op
      if (op.kind === 'pull') {
        const r = await fetch('remote', [key])
        if (!(key in r)) {
          step(false)
          continue
        }
        const [ok] = await adapter.apply([{ key, payload: r[key], expect: local[key] ?? null }])
        step(ok)
      } else if (op.kind === 'push') {
        const l = await fetch('local', [key])
        const [ok] = await applyRemote([{ key, payload: l[key], expect: remote[key] ?? null }])
        step(ok)
      } else if (op.kind === 'delLocal') {
        const [ok] = await adapter.apply([{ key, payload: null, expect: local[key] }])
        step(ok)
      } else if (op.kind === 'delRemote') {
        const [ok] = await applyRemote([{ key, payload: null, expect: remote[key] }])
        step(ok)
      } else {
        // Both changed: the coordinator's (this PC's) version keeps the key;
        // the peer's becomes a copy on both sides.
        const r = await fetch('remote', [key])
        const l = await fetch('local', [key])
        if (!(key in r) || !(key in l)) {
          step(false)
          continue
        }
        const copyKey = adapter.copyKey(key, them)
        const copy = adapter.asCopy(r[key], copyKey, them)
        const [okR1, okR2] = await applyRemote([
          { key: copyKey, payload: copy, expect: remote[copyKey] ?? null },
          { key, payload: l[key], expect: remote[key] }
        ])
        const [okL] = await adapter.apply([{ key: copyKey, payload: copy, expect: local[copyKey] ?? null }])
        step(okR1 && okR2 && okL)
      }
    }

    // Agree on the new base from what both sides now actually hold.
    const after = await adapter.manifest()
    const afterRemote = (await call('sync.manifest', {})) as Hashes
    this.deps.bases.set(p.id, cat, nextBase(after, afterRemote, base))
    if (failed) {
      this.report(p.id, { category: cat, phase: 'error', done, total, error: `${failed} 項沒有同步（對方或這台正在修改，或內容不允許），下一輪再試`, at: Date.now() })
    } else {
      this.report(p.id, { category: cat, phase: 'done', done, total, at: Date.now() })
    }
    if (total) this.deps.log.info(`sync ${cat} with ${p.name}: ${total - failed}/${total} applied`)
  }
}
