import '../test-utils/jsdom-env'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, SessionInfo } from '@shared/types'
import type { useApp as UseApp } from './sessions'

// The store owns the rule that decides which Claude identity a new tab runs
// under. Getting it wrong silently runs work under the wrong account, which is
// invisible until it has already happened — so it is pinned down here.

let store: typeof UseApp
let created: Parameters<Window['api']['createSession']>[0][]
let savedSnapshots: Parameters<Window['api']['saveSessionSnapshot']>[0][]
let killed: string[]
let seq: number

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    defaultCwd: 'C:\\default',
    accounts: [
      { id: 'work', label: 'Work', configDir: 'C:\\acc\\work' },
      { id: 'personal', label: 'Personal', configDir: 'C:\\acc\\personal' }
    ],
    currentAccountId: null,
    groups: [],
    restoreTabs: false,
    closeToTray: true,
    notifyOnAttention: true,
    terminalFontSize: 13,
    updateDir: '',
    checkUpdatesOnLaunch: true,
    ...overrides
  }
}

/** Minimal window.api double — only the surface the store actually touches. */
function installApi(appSettings: AppSettings, snapshot?: { tabs: unknown[]; activeIndex: number }): void {
  created = []
  savedSnapshots = []
  killed = []
  seq = 0

  const api = {
    listProviders: vi.fn(async () => []),
    getSettings: vi.fn(async () => appSettings),
    updateSettings: vi.fn(async (patch: Partial<AppSettings>) => ({ ...appSettings, ...patch })),
    createSession: vi.fn(async (opts: Parameters<Window['api']['createSession']>[0]) => {
      created.push(opts)
      const info: SessionInfo = {
        id: `s${++seq}`,
        provider: opts.provider,
        cwd: opts.cwd ?? appSettings.defaultCwd,
        status: 'running'
      }
      return info
    }),
    killSession: vi.fn((id: string) => void killed.push(id)),
    saveSessionSnapshot: vi.fn(async (snap: Parameters<Window['api']['saveSessionSnapshot']>[0]) => {
      savedSnapshots.push(snap)
    }),
    getSessionSnapshot: vi.fn(async () => snapshot ?? { tabs: [], activeIndex: 0 }),
    runScript: vi.fn(async () => null),
    onStatus: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    onLoginUrl: vi.fn(() => () => {}),
    onData: vi.fn(() => () => {})
  }

  // Cast: the double intentionally implements only the used subset.
  ;(window as unknown as { api: unknown }).api = api
}

async function loadStore(appSettings = settings(), snapshot?: { tabs: unknown[]; activeIndex: number }) {
  installApi(appSettings, snapshot)
  vi.resetModules()
  store = (await import('./sessions')).useApp
  await store.getState().init()
  return store
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('account resolution for a new session', () => {
  it("uses the selected group's bound account, not the globally current one", async () => {
    await loadStore(
      settings({
        currentAccountId: 'personal',
        groups: [{ id: 'g1', name: 'Work stuff', accountId: 'work' }]
      })
    )

    store.getState().selectGroup('g1')
    await store.getState().createSession('claude')

    expect(created[0].accountId).toBe('work')
  })

  it('lets an explicitly passed account beat the group binding', async () => {
    await loadStore(settings({ groups: [{ id: 'g1', name: 'G', accountId: 'work' }] }))

    store.getState().selectGroup('g1')
    await store.getState().createSession('claude', { accountId: 'personal' })

    expect(created[0].accountId).toBe('personal')
  })

  it('passes no account when the session lands outside any group', async () => {
    await loadStore(settings({ currentAccountId: 'personal' }))

    await store.getState().createSession('claude')

    // Left undefined so the main process resolves the current account itself.
    expect(created[0].accountId).toBeUndefined()
  })

  it('honors an explicit groupId over the selected group (the restore path)', async () => {
    await loadStore(
      settings({
        groups: [
          { id: 'g1', name: 'One', accountId: 'work' },
          { id: 'g2', name: 'Two', accountId: 'personal' }
        ]
      })
    )

    store.getState().selectGroup('g1')
    await store.getState().createSession('claude', { groupId: 'g2' })

    expect(created[0].accountId).toBe('personal')
    const { sessions, sessionGroupId } = store.getState()
    expect(sessionGroupId[sessions[0].id]).toBe('g2')
  })
})

describe('launch mode', () => {
  it('maps the new/continue/pick wrappers onto the right launch kind', async () => {
    await loadStore()
    const s = store.getState()

    await s.newSession('claude')
    await s.continueSession('claude')
    await s.pickSession('claude')

    expect(created.map((c) => c.launch?.kind)).toEqual(['new', 'continue', 'pick'])
  })
})

describe('closeSession', () => {
  it('kills the pty and clears every per-session map', async () => {
    await loadStore(settings({ groups: [{ id: 'g1', name: 'G', accountId: 'work' }] }))
    store.getState().selectGroup('g1')
    await store.getState().createSession('claude', { name: 'my tab' })

    const id = store.getState().sessions[0].id
    store.getState().closeSession(id)

    const s = store.getState()
    expect(killed).toEqual([id])
    expect(s.sessions).toHaveLength(0)
    expect(s.activeId).toBeNull()
    expect(s.sessionGroupId[id]).toBeUndefined()
    expect(s.sessionName[id]).toBeUndefined()
    expect(s.sessionAccountId[id]).toBeUndefined()
    expect(Object.values(s.groupLastActive)).not.toContain(id)
  })

  it('falls back to the last remaining tab when the active one closes', async () => {
    await loadStore()
    await store.getState().createSession('claude')
    await store.getState().createSession('claude')

    const [first, second] = store.getState().sessions
    store.getState().setActive(second.id)
    store.getState().closeSession(second.id)

    expect(store.getState().activeId).toBe(first.id)
  })
})

describe('persistSnapshot', () => {
  it('persists only the resumable claude/codex tabs', async () => {
    await loadStore()
    const s = store.getState()
    await s.createSession('claude')
    await s.createSession('shell')
    await s.createSession('codex')

    const last = savedSnapshots[savedSnapshots.length - 1]
    expect(last.tabs.map((t) => t.provider)).toEqual(['claude', 'codex'])
  })

  it('does not write snapshots while tabs are being restored', async () => {
    await loadStore(settings({ restoreTabs: true }), {
      tabs: [
        { provider: 'claude', cwd: 'C:\\a', groupId: null },
        { provider: 'claude', cwd: 'C:\\b', groupId: null }
      ],
      activeIndex: 1
    })

    // Two tabs replayed, but only the single post-restore write is persisted.
    expect(created).toHaveLength(2)
    expect(savedSnapshots).toHaveLength(1)
    expect(created.every((c) => c.launch?.kind === 'continue')).toBe(true)
  })
})

describe('toasts', () => {
  it('adds and dismisses a toast by id', async () => {
    await loadStore()
    store.getState().pushToast('boom')

    const [toast] = store.getState().toasts
    expect(toast.message).toBe('boom')

    store.getState().dismissToast(toast.id)
    expect(store.getState().toasts).toHaveLength(0)
  })

  it('auto-dismisses after the timeout', async () => {
    vi.useFakeTimers()
    try {
      await loadStore()
      store.getState().pushToast('temporary')
      expect(store.getState().toasts).toHaveLength(1)

      vi.advanceTimersByTime(6000)
      expect(store.getState().toasts).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('groups', () => {
  it('reassigns orphaned sessions to 未分組 when their group is removed', async () => {
    await loadStore(settings({ groups: [{ id: 'g1', name: 'G', accountId: 'work' }] }))
    store.getState().selectGroup('g1')
    await store.getState().createSession('claude')
    const id = store.getState().sessions[0].id

    await store.getState().removeGroup('g1')

    expect(store.getState().sessionGroupId[id]).toBeNull()
    expect(store.getState().selectedGroupId).toBeNull()
  })

  it('jumps to a group\'s last active session when selected', async () => {
    await loadStore(settings({ groups: [{ id: 'g1', name: 'G', accountId: 'work' }] }))
    store.getState().selectGroup('g1')
    await store.getState().createSession('claude')
    const inGroup = store.getState().sessions[0].id

    store.getState().selectGroup(null)
    await store.getState().createSession('claude')

    store.getState().selectGroup('g1')
    expect(store.getState().activeId).toBe(inGroup)
  })
})
