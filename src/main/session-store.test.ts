import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionSnapshot } from '../shared/types'

// sessions.json is rewritten on every tab change and read back at startup, so
// a malformed or stale file must degrade to "no tabs" instead of breaking
// launch. These tests pin that tolerance.

let userData: string
let roots: string[] = []

vi.mock('electron', () => ({
  app: {
    getPath: (name: string): string => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    }
  }
}))

const snapshotFile = (): string => join(userData, 'sessions.json')

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'lp-sessions-'))
  roots.push(root)
  userData = join(root, 'userData')
  mkdirSync(userData, { recursive: true })
  vi.resetModules()
})

afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
  roots = []
})

describe('getSnapshot', () => {
  it('returns an empty snapshot when the file is missing', async () => {
    const { getSnapshot } = await import('./session-store')
    expect(getSnapshot()).toEqual({ tabs: [], activeIndex: 0 })
  })

  it('returns an empty snapshot when the file is corrupt', async () => {
    writeFileSync(snapshotFile(), '{ this is not json', 'utf8')
    const { getSnapshot } = await import('./session-store')
    expect(getSnapshot()).toEqual({ tabs: [], activeIndex: 0 })
  })

  it('drops entries with no provider and normalizes missing fields', async () => {
    writeFileSync(
      snapshotFile(),
      JSON.stringify({
        tabs: [
          { provider: 'claude', cwd: 'C:\\work', groupId: 'g1', name: 'tab', accountId: 'work' },
          { cwd: 'C:\\orphan' },
          { provider: 'codex' }
        ],
        activeIndex: 0
      }),
      'utf8'
    )

    const { getSnapshot } = await import('./session-store')
    const snap = getSnapshot()

    expect(snap.tabs).toHaveLength(2)
    expect(snap.tabs[0]).toEqual({
      provider: 'claude',
      cwd: 'C:\\work',
      groupId: 'g1',
      name: 'tab',
      accountId: 'work',
      claudeSessionId: undefined
    })
    // Missing cwd/groupId become the documented defaults, not undefined holes.
    expect(snap.tabs[1].cwd).toBe('')
    expect(snap.tabs[1].groupId).toBeNull()
  })

  it('clamps an out-of-range activeIndex to 0', async () => {
    writeFileSync(
      snapshotFile(),
      JSON.stringify({ tabs: [{ provider: 'claude' }], activeIndex: 99 }),
      'utf8'
    )

    const { getSnapshot } = await import('./session-store')
    expect(getSnapshot().activeIndex).toBe(0)
  })
})

describe('saveSnapshot', () => {
  it('round-trips through disk', async () => {
    const { saveSnapshot, getSnapshot } = await import('./session-store')
    const snap: SessionSnapshot = {
      tabs: [
        { provider: 'claude', cwd: 'C:\\a', groupId: null },
        { provider: 'codex', cwd: 'C:\\b', groupId: 'g2' }
      ],
      activeIndex: 1
    }
    saveSnapshot(snap)

    expect(JSON.parse(readFileSync(snapshotFile(), 'utf8')).activeIndex).toBe(1)
    expect(getSnapshot().tabs.map((t) => t.provider)).toEqual(['claude', 'codex'])
  })

  it('sanitizes junk on the way in, not just on the way out', async () => {
    const { saveSnapshot, getSnapshot } = await import('./session-store')
    saveSnapshot({
      tabs: [{ provider: 'claude', cwd: 'C:\\a', groupId: null }, null, { cwd: 'x' }],
      activeIndex: 5
    } as unknown as SessionSnapshot)

    const written = JSON.parse(readFileSync(snapshotFile(), 'utf8'))
    expect(written.tabs).toHaveLength(1)
    expect(written.activeIndex).toBe(0)
    expect(getSnapshot().tabs).toHaveLength(1)
  })
})
