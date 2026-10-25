import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SyncCategory } from '../shared/types'
import { LanSync, nextBase, plan, type Hashes, type SyncPeer } from './lan-sync'
import { recordAdapter, skillsAdapter, validateSkill } from './lan-sync-adapters'

// The merge rules pinned here are the ones whose failure loses data: an edit
// overwritten, a deletion that resurrects, or a first sync that deletes.

describe('plan', () => {
  it('copies one-sided changes and never deletes on a first sync', () => {
    expect(plan({ a: '1' }, { b: '2' }, null)).toEqual([
      { kind: 'push', key: 'a' },
      { kind: 'pull', key: 'b' }
    ])
  })

  it('takes the side that changed since the base', () => {
    const base = { a: '1', b: '1' }
    expect(plan({ a: '2', b: '1' }, { a: '1', b: '3' }, base)).toEqual([
      { kind: 'push', key: 'a' },
      { kind: 'pull', key: 'b' }
    ])
  })

  it('propagates a deletion only when the other side is untouched', () => {
    const base = { a: '1', b: '1' }
    expect(plan({ b: '1' }, { a: '1', b: '1' }, base)).toEqual([{ kind: 'delRemote', key: 'a' }])
    // Deleted here, edited there: the edit comes back.
    expect(plan({ b: '1' }, { a: '9', b: '1' }, base)).toEqual([{ kind: 'pull', key: 'a' }])
  })

  it('flags both-changed as a conflict, and an unsynced both-sides item too', () => {
    expect(plan({ a: '2' }, { a: '3' }, { a: '1' })).toEqual([{ kind: 'conflict', key: 'a' }])
    expect(plan({ a: '2' }, { a: '3' }, null)).toEqual([{ kind: 'conflict', key: 'a' }])
  })
})

describe('nextBase', () => {
  it('keeps what both agree on, and the old entry for anything unsettled', () => {
    expect(nextBase({ a: '1', b: '2' }, { a: '1', b: '3' }, { b: '0', gone: '5' })).toEqual({ a: '1', b: '0' })
  })
})

// ---- two PCs over in-memory records ----

interface Rec {
  id: string
  text: string
}

function memoryStore(initial: Rec[]): { items: Map<string, Rec>; adapter: ReturnType<typeof recordAdapter> } {
  const items = new Map(initial.map((r) => [r.id, r]))
  const adapter = recordAdapter<Rec>({
    items: () => [...items.values()],
    fingerprint: (r) => r,
    write: (put, remove) => {
      for (const id of remove) items.delete(id)
      for (const p of put as Rec[]) items.set(p.id, p)
    },
    asCopy: (r, id, from) => ({ ...r, id, text: `${r.text} (from ${from})` })
  })
  return { items, adapter }
}

function pair(aRecs: Rec[], bRecs: Rec[], aKnowsBTicked = true) {
  const quiet = { info: () => {}, warn: () => {} }
  const a = memoryStore(aRecs)
  const b = memoryStore(bRecs)
  const bases = new Map<string, Hashes>()
  const peerOf = (id: string, name: string, mine: boolean, theirs: boolean): SyncPeer => ({
    id,
    name,
    online: true,
    mine: { knowledge: mine },
    theirs: { knowledge: theirs }
  })
  /** Each PC's own tick, and what each believes the other ticked. */
  const ticks = { a: true, b: true }
  const known = { a: aKnowsBTicked, b: true }
  const nodes: Record<string, LanSync> = {}
  const make = (me: 'a' | 'b', store: typeof a): LanSync => {
    const other = me === 'a' ? 'b' : 'a'
    const adapters = { knowledge: store.adapter, skills: store.adapter, hooks: store.adapter } as Record<SyncCategory, typeof store.adapter>
    return new LanSync({
      myId: () => `id-${me}`,
      peers: () => [peerOf(`id-${other}`, other.toUpperCase(), ticks[me], known[me])],
      setMine: () => {},
      setTheirs: (_id, flags) => void (known[me] = flags.knowledge === true),
      request: (_id, method, params) => nodes[other].serve(`id-${me}`, method, JSON.parse(JSON.stringify(params))),
      adapters,
      bases: { get: (p, c) => (me === 'a' ? (bases.get(`${p}/${c}`) ?? null) : null), set: (p, c, v) => void bases.set(`${p}/${c}`, v) },
      log: quiet
    })
  }
  nodes.a = make('a', a)
  nodes.b = make('b', b)
  return { a, b, run: () => nodes.a.syncPeer('id-b'), nodes, ticks }
}

describe('LanSync between two PCs', () => {
  it('ends with the same items on both sides, keeping both versions of a conflict', async () => {
    const { a, b, run } = pair(
      [{ id: 'x', text: 'mine' }, { id: 'only-a', text: 'a' }],
      [{ id: 'x', text: 'theirs' }, { id: 'only-b', text: 'b' }]
    )
    await run()
    const ids = (m: Map<string, Rec>) => [...m.keys()].sort()
    expect(ids(a.items)).toEqual(ids(b.items))
    expect(a.items.get('x')?.text).toBe('mine') // the coordinator (smaller id) keeps the key
    expect(b.items.get('x')?.text).toBe('mine')
    expect(a.items.get('x~idb')?.text).toBe('theirs (from B)')
    expect(b.items.get('x~idb')?.text).toBe('theirs (from B)')
  })

  it('propagates a later deletion, but not over an edit', async () => {
    const { a, b, run } = pair([{ id: 'k', text: '1' }, { id: 'j', text: '1' }], [])
    await run()
    a.items.delete('k')
    b.items.set('j', { id: 'j', text: 'edited' })
    a.items.delete('j')
    await run()
    expect(b.items.has('k')).toBe(false)
    expect(a.items.get('j')?.text).toBe('edited')
  })

  it("still starts when the other PC's tick never arrived (one-way firewall)", async () => {
    const { b, nodes } = pair([{ id: 'k', text: '1' }], [], false)
    nodes.a.tick()
    await new Promise((r) => setTimeout(r, 50))
    await nodes.a.syncPeer('id-b')
    expect(b.items.get('k')?.text).toBe('1')
  })

  it('refuses when the other PC has not ticked the category', async () => {
    const { a, nodes, ticks } = pair([{ id: 'k', text: '1' }], [])
    ticks.b = false
    await expect(nodes.b.serve('id-a', 'sync.manifest', { category: 'knowledge' })).rejects.toMatchObject({ status: 403 })
    expect(a.items.size).toBe(1)
  })
})

// ---- skills on disk ----

let tmp: string
afterEach(() => tmp && rmSync(tmp, { recursive: true, force: true }))

function skill(root: string, name: string, files: Record<string, string>): void {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, name, ...p.split('/').slice(0, -1)), { recursive: true })
    writeFileSync(join(root, name, ...p.split('/')), text)
  }
}

describe('skillsAdapter', () => {
  it('copies a skill folder, backing up the version it replaces', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'bg-skills-'))
    const a = skillsAdapter(join(tmp, 'a', 'skills'), join(tmp, 'a', 'work'))
    const b = skillsAdapter(join(tmp, 'b', 'skills'), join(tmp, 'b', 'work'))
    skill(join(tmp, 'a', 'skills'), 'demo', { 'SKILL.md': '---\nname: demo\n---\nv2', 'scripts/run.ps1': 'x' })
    skill(join(tmp, 'b', 'skills'), 'demo', { 'SKILL.md': 'v1' })
    const ma = await a.manifest()
    const mb = await b.manifest()
    const payload = (await a.read(['demo'])).demo
    expect(await b.apply([{ key: 'demo', payload, expect: mb.demo }])).toEqual([true])
    expect((await b.manifest()).demo).toBe(ma.demo)
    expect(readFileSync(join(tmp, 'b', 'skills', 'demo', 'scripts', 'run.ps1'), 'utf8')).toBe('x')
    expect(readdirSync(join(tmp, 'b', 'work', 'backup'))).toHaveLength(1)
  })

  it('skips a write when the folder changed since planning', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'bg-skills-'))
    const b = skillsAdapter(join(tmp, 'skills'), join(tmp, 'work'))
    skill(join(tmp, 'skills'), 'demo', { 'SKILL.md': 'now' })
    const payload = { files: [{ path: 'SKILL.md', data: Buffer.from('new').toString('base64') }] }
    expect(await b.apply([{ key: 'demo', payload, expect: 'stale-hash' }])).toEqual([false])
    expect(readFileSync(join(tmp, 'skills', 'demo', 'SKILL.md'), 'utf8')).toBe('now')
  })

  it('rejects paths that escape or are not valid on Windows', () => {
    const f = (path: string) => ({ files: [{ path, data: '' }] })
    expect(() => validateSkill(f('../evil.ps1'))).toThrow()
    expect(() => validateSkill(f('C:/x'))).toThrow()
    expect(() => validateSkill(f('a/CON'))).toThrow()
    expect(() => validateSkill(f('file.txt:ads'))).toThrow()
    expect(() => validateSkill({ files: [{ path: 'A.md', data: '' }, { path: 'a.md', data: '' }] })).toThrow()
    expect(() => validateSkill(f('ok/SKILL.md'))).not.toThrow()
  })

  it('renames a conflict copy inside SKILL.md and deletes into the backup', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'bg-skills-'))
    const a = skillsAdapter(join(tmp, 'skills'), join(tmp, 'work'))
    skill(join(tmp, 'skills'), 'demo', { 'SKILL.md': '---\nname: demo\n---\nbody' })
    const key = a.copyKey('demo', { id: 'x', name: 'IDLE PC' })
    expect(key).toBe('demo-from-IDLE-PC')
    const copy = a.asCopy((await a.read(['demo'])).demo, key, { id: 'x', name: 'IDLE PC' }) as { files: { data: string }[] }
    expect(Buffer.from(copy.files[0].data, 'base64').toString()).toContain(`name: ${key}`)
    const m = await a.manifest()
    expect(await a.apply([{ key: 'demo', payload: null, expect: m.demo }])).toEqual([true])
    expect(existsSync(join(tmp, 'skills', 'demo'))).toBe(false)
  })
})
