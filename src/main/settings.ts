import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import type { Account, AppSettings, LaunchAtLoginState, SessionGroup } from '../shared/types'
import {
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN
} from '../shared/types'
import { writeFileAtomic } from './atomic-write'

// Persist a small JSON blob in the app's userData dir. This holds the default
// working directory and the list of extra Claude accounts. Each account maps to
// an isolated CLAUDE_CONFIG_DIR so multiple Claude logins can coexist.

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function accountsRoot(): string {
  return join(app.getPath('userData'), 'accounts')
}

function defaults(): AppSettings {
  return {
    defaultCwd: os.homedir(),
    accounts: [],
    currentAccountId: null,
    groups: [],
    restoreTabs: true,
    closeToTray: true,
    notifyOnAttention: true,
    terminalFontSize: TERMINAL_FONT_SIZE_DEFAULT,
    updateDir: '',
    checkUpdatesOnLaunch: true
  }
}

/** Clamp to the supported range; anything non-numeric falls back to the default. */
function clampFontSize(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : TERMINAL_FONT_SIZE_DEFAULT
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, n))
}

let cache: AppSettings | null = null

function load(): AppSettings {
  if (cache) return cache
  try {
    const raw = readFileSync(settingsPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    cache = {
      defaultCwd: parsed.defaultCwd || os.homedir(),
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      currentAccountId: parsed.currentAccountId ?? null,
      groups: Array.isArray(parsed.groups)
        ? parsed.groups.map((g: Partial<SessionGroup>) => ({
            id: g.id ?? '',
            name: g.name ?? '',
            accountId: g.accountId ?? 'default'
          }))
        : [],
      restoreTabs: parsed.restoreTabs ?? true,
      closeToTray: parsed.closeToTray ?? true,
      notifyOnAttention: parsed.notifyOnAttention ?? true,
      terminalFontSize: clampFontSize(parsed.terminalFontSize),
      updateDir: typeof parsed.updateDir === 'string' ? parsed.updateDir : '',
      checkUpdatesOnLaunch: parsed.checkUpdatesOnLaunch ?? true
    }
  } catch {
    cache = defaults()
  }
  return cache
}

function persist(next: AppSettings): AppSettings {
  cache = next
  try {
    writeFileAtomic(settingsPath(), JSON.stringify(next, null, 2))
  } catch {
    /* best-effort; keep in-memory cache regardless */
  }
  return next
}

export function getSettings(): AppSettings {
  return load()
}

/**
 * Merge a partial patch (used for defaultCwd from the settings panel).
 *
 * The patch arrives over IPC from the renderer, so each field is picked and
 * type-checked rather than spread blindly: one bad value (say `accounts: null`)
 * would otherwise poison both the cache and the file on disk, and every later
 * account operation would throw on every launch with no way to recover from
 * inside the app.
 */
export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const current = load()
  const next: AppSettings = { ...current }

  if (typeof patch?.defaultCwd === 'string') next.defaultCwd = patch.defaultCwd
  if (typeof patch?.restoreTabs === 'boolean') next.restoreTabs = patch.restoreTabs
  if (typeof patch?.closeToTray === 'boolean') next.closeToTray = patch.closeToTray
  if (typeof patch?.notifyOnAttention === 'boolean') next.notifyOnAttention = patch.notifyOnAttention
  if (typeof patch?.terminalFontSize === 'number') next.terminalFontSize = clampFontSize(patch.terminalFontSize)
  if (typeof patch?.updateDir === 'string') next.updateDir = patch.updateDir.trim()
  if (typeof patch?.checkUpdatesOnLaunch === 'boolean') next.checkUpdatesOnLaunch = patch.checkUpdatesOnLaunch
  if (patch?.currentAccountId === null || typeof patch?.currentAccountId === 'string') {
    next.currentAccountId = patch.currentAccountId
  }
  if (Array.isArray(patch?.accounts)) {
    next.accounts = patch.accounts.filter(
      (a): a is Account =>
        !!a && typeof a.id === 'string' && typeof a.label === 'string' && typeof a.configDir === 'string'
    )
  }
  if (Array.isArray(patch?.groups)) {
    next.groups = patch.groups
      .filter((g): g is SessionGroup => !!g && typeof g.id === 'string' && typeof g.name === 'string')
      .map((g) => ({ id: g.id, name: g.name, accountId: g.accountId ?? 'default' }))
  }

  return persist(next)
}

function slugify(label: string): string {
  const base = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return base || 'account'
}

/** Create a new account with an isolated config dir under userData/accounts. */
export function addAccount(label: string): Account {
  const s = load()
  const name = label.trim() || '未命名帳號'
  // Ensure a unique id even if labels collide.
  let id = slugify(name)
  const taken = new Set(s.accounts.map((a) => a.id))
  if (taken.has(id)) {
    let n = 2
    while (taken.has(`${id}-${n}`)) n++
    id = `${id}-${n}`
  }
  const configDir = join(accountsRoot(), id)
  try {
    mkdirSync(configDir, { recursive: true })
  } catch {
    /* dir may already exist */
  }
  const account: Account = { id, label: name, configDir }
  persist({ ...s, accounts: [...s.accounts, account] })
  return account
}

export function renameAccount(id: string, label: string): AppSettings {
  const s = load()
  return persist({
    ...s,
    accounts: s.accounts.map((a) => (a.id === id ? { ...a, label: label.trim() || a.label } : a))
  })
}

/** Remove an account from the list. The config dir (credentials) is left on disk. */
export function removeAccount(id: string): AppSettings {
  const s = load()
  return persist({
    ...s,
    accounts: s.accounts.filter((a) => a.id !== id),
    currentAccountId: s.currentAccountId === id ? null : s.currentAccountId,
    groups: s.groups.map((g) => (g.accountId === id ? { ...g, accountId: 'default' } : g))
  })
}

export function setCurrentAccount(id: string | null): AppSettings {
  const s = load()
  const valid = id === null || s.accounts.some((a) => a.id === id)
  return persist({ ...s, currentAccountId: valid ? id : null })
}

/**
 * Resolve the CLAUDE_CONFIG_DIR for a given account selector.
 * `null` or 'default' → undefined (use the built-in ~/.claude).
 * Ensures the target dir exists before returning it.
 */
export function resolveClaudeConfigDir(accountId: string | null | undefined): string | undefined {
  if (!accountId || accountId === 'default') return undefined
  const account = load().accounts.find((a) => a.id === accountId)
  if (!account) return undefined
  if (!existsSync(account.configDir)) {
    try {
      mkdirSync(account.configDir, { recursive: true })
    } catch {
      /* ignore */
    }
  }
  return account.configDir
}

// ---- Launch at login -----------------------------------------------------
//
// Deliberately NOT stored in settings.json. The OS owns this: the user can
// turn it off in Windows Settings or Task Manager without telling us, and a
// copy in our own file would then quietly disagree with reality. We always
// read it back from the OS instead.
//
// Only offered from a packaged build. Unpackaged, `process.execPath` is
// electron.exe inside node_modules, so registering it would add a startup
// entry pointing at a dev binary and a checkout path — and every throwaway
// `electron .` run would silently write one.

export function getLaunchAtLogin(): LaunchAtLoginState {
  if (!app.isPackaged) return { supported: false, enabled: false }
  return { supported: true, enabled: app.getLoginItemSettings().openAtLogin }
}

export function setLaunchAtLogin(enabled: boolean): LaunchAtLoginState {
  if (!app.isPackaged) return { supported: false, enabled: false }
  app.setLoginItemSettings({ openAtLogin: !!enabled })
  // Report what the OS actually did rather than what we asked for.
  return { supported: true, enabled: app.getLoginItemSettings().openAtLogin }
}
