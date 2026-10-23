import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Accounts now exist per CLI. The rules pinned here are the ones a mistake in
// would silently run a session under the wrong identity: an old settings file
// keeps meaning Claude, and one CLI's account is never handed to another CLI
// (a group's bound Claude account must not become Codex's CODEX_HOME).

let userData: string

vi.mock('electron', () => ({
  app: {
    getPath: () => userData,
    isPackaged: false,
    getAppPath: () => userData
  }
}))

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'bg-settings-'))
  vi.resetModules()
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

describe('accounts per provider', () => {
  it('reads accounts saved before `provider` existed as Claude accounts', async () => {
    writeFileSync(
      join(userData, 'settings.json'),
      JSON.stringify({ accounts: [{ id: 'work', label: 'Work', configDir: 'C:\\acc\\work' }] })
    )
    const { getSettings, resolveClaudeConfigDir } = await import('./settings')
    expect(getSettings().accounts[0].provider).toBe('claude')
    expect(getSettings().currentAccounts).toEqual({})
    expect(resolveClaudeConfigDir('work')).toBe('C:\\acc\\work')
  })

  it("never resolves one CLI's account for another", async () => {
    const { addAccount, resolveAccountDir } = await import('./settings')
    const claude = addAccount('Work')
    const codex = addAccount('Work', 'codex')
    expect(codex.id).not.toBe(claude.id)
    expect(codex.configDir).toBe(join(userData, 'accounts', 'codex', codex.id))
    expect(resolveAccountDir('codex', claude.id)).toBeUndefined()
    expect(resolveAccountDir('claude', codex.id)).toBeUndefined()
    expect(resolveAccountDir('codex', codex.id)).toBe(codex.configDir)
    expect(resolveAccountDir('codex', 'default')).toBeUndefined()
  })

  it('keeps a current account per CLI and clears it when that account is removed', async () => {
    const { addAccount, setCurrentAccount, currentAccountFor, removeAccount } = await import('./settings')
    const codex = addAccount('Alt', 'codex')
    setCurrentAccount(codex.id, 'codex')
    expect(currentAccountFor('codex')).toBe(codex.id)
    expect(currentAccountFor('claude')).toBeNull()
    // Selecting it as Claude's current account is refused.
    setCurrentAccount(codex.id, 'claude')
    expect(currentAccountFor('claude')).toBeNull()
    removeAccount(codex.id)
    expect(currentAccountFor('codex')).toBeNull()
  })
})
