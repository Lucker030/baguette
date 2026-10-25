import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import os from 'node:os'
import type { Account, AccountProvider, AppSettings, LaunchAtLoginState, SessionGroup } from '../shared/types'
import {
  ACCOUNT_PROVIDERS,
  AUTO_APPROVE_PROVIDERS,
  PROVIDERS,
  isAccountProvider,
  isRuntimePref,
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN
} from '../shared/types'
import { writeFileAtomic } from './atomic-write'

// Persist a small JSON blob in the app's userData dir. This holds the default
// working directory and the list of extra accounts. Each account maps to an
// isolated config dir (CLAUDE_CONFIG_DIR / CODEX_HOME / COPILOT_HOME) so
// several logins of the same CLI can coexist.

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function accountsRoot(): string {
  return join(app.getPath('userData'), 'accounts')
}

/**
 * Where new sessions start until the user picks something else: the folder
 * the app's own exe sits in, not the user profile on C:. The user keeps the
 * app next to their work (often on another drive), so that is the useful
 * starting point.
 *
 * - portable build: electron-builder's portable stub unpacks to a temp dir
 *   and says where the real .exe was in PORTABLE_EXECUTABLE_DIR;
 * - installed / unpacked build: the folder of process.execPath;
 * - `electron-vite dev`: execPath is electron.exe inside node_modules, so use
 *   the project folder instead.
 */
export function exeDir(): string {
  const portable = process.env.PORTABLE_EXECUTABLE_DIR
  if (portable) return portable
  if (app.isPackaged) return dirname(app.getPath('exe'))
  return app.getAppPath() || os.homedir()
}

function defaults(): AppSettings {
  return {
    defaultCwd: exeDir(),
    accounts: [],
    currentAccountId: null,
    currentAccounts: {},
    groups: [],
    restoreTabs: true,
    closeToTray: true,
    notifyOnAttention: true,
    agentBridge: true,
    terminalFontSize: TERMINAL_FONT_SIZE_DEFAULT,
    checkUpdatesOnLaunch: true,
    runtimePrefs: {},
    autoApprove: {},
    // Off until the user turns it on: it opens a port to the whole LAN.
    lanEnabled: false,
    lanDeviceName: ''
  }
}

/** A device name as shown to other PCs: one line, bounded. */
function cleanDeviceName(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 40) : ''
}

/** Clamp to the supported range; anything non-numeric falls back to the default. */
function clampFontSize(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : TERMINAL_FONT_SIZE_DEFAULT
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, n))
}

/**
 * Keep only well-formed accounts. Ones written before accounts had a
 * `provider` are Claude's — that was the only kind there was.
 */
function normalizeAccounts(value: unknown): Account[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(
      (a): a is Account =>
        !!a && typeof a.id === 'string' && typeof a.label === 'string' && typeof a.configDir === 'string'
    )
    .map((a) => ({
      id: a.id,
      label: a.label,
      configDir: a.configDir,
      provider: isAccountProvider(a.provider) ? a.provider : 'claude'
    }))
}

/** `{ codex: 'id' | null, ... }` with unknown keys and non-string ids dropped. */
function normalizeCurrentAccounts(value: unknown): AppSettings['currentAccounts'] {
  const out: AppSettings['currentAccounts'] = {}
  if (!value || typeof value !== 'object') return out
  for (const p of ACCOUNT_PROVIDERS) {
    const v = (value as Record<string, unknown>)[p]
    if (v === null || typeof v === 'string') out[p] = v
  }
  return out
}

/** `{ codex: 'wsl', ... }` with unknown providers and values dropped. */
function normalizeRuntimePrefs(value: unknown): AppSettings['runtimePrefs'] {
  const out: AppSettings['runtimePrefs'] = {}
  if (!value || typeof value !== 'object') return out
  for (const p of PROVIDERS) {
    const v = (value as Record<string, unknown>)[p]
    if (isRuntimePref(v)) out[p] = v
  }
  return out
}

/** `{ antigravity: true }` with providers that have no such switch, and non-booleans, dropped. */
function normalizeAutoApprove(value: unknown): AppSettings['autoApprove'] {
  const out: AppSettings['autoApprove'] = {}
  if (!value || typeof value !== 'object') return out
  for (const p of AUTO_APPROVE_PROVIDERS) {
    const v = (value as Record<string, unknown>)[p]
    if (typeof v === 'boolean') out[p] = v
  }
  return out
}

let cache: AppSettings | null = null

function load(): AppSettings {
  if (cache) return cache
  try {
    const raw = readFileSync(settingsPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    cache = {
      defaultCwd: parsed.defaultCwd || exeDir(),
      accounts: normalizeAccounts(parsed.accounts),
      currentAccountId: parsed.currentAccountId ?? null,
      currentAccounts: normalizeCurrentAccounts(parsed.currentAccounts),
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
      agentBridge: parsed.agentBridge ?? true,
      terminalFontSize: clampFontSize(parsed.terminalFontSize),
      runtimePrefs: normalizeRuntimePrefs(parsed.runtimePrefs),
      checkUpdatesOnLaunch: parsed.checkUpdatesOnLaunch ?? true,
      autoApprove: normalizeAutoApprove(parsed.autoApprove),
      lanEnabled: parsed.lanEnabled === true,
      lanDeviceName: cleanDeviceName(parsed.lanDeviceName)
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
  if (typeof patch?.agentBridge === 'boolean') next.agentBridge = patch.agentBridge
  if (typeof patch?.terminalFontSize === 'number') next.terminalFontSize = clampFontSize(patch.terminalFontSize)
  if (typeof patch?.checkUpdatesOnLaunch === 'boolean') next.checkUpdatesOnLaunch = patch.checkUpdatesOnLaunch
  if (typeof patch?.lanEnabled === 'boolean') next.lanEnabled = patch.lanEnabled
  if (typeof patch?.lanDeviceName === 'string') next.lanDeviceName = cleanDeviceName(patch.lanDeviceName)
  if (patch?.currentAccountId === null || typeof patch?.currentAccountId === 'string') {
    next.currentAccountId = patch.currentAccountId
  }
  if (Array.isArray(patch?.accounts)) next.accounts = normalizeAccounts(patch.accounts)
  if (patch?.runtimePrefs && typeof patch.runtimePrefs === 'object') {
    next.runtimePrefs = normalizeRuntimePrefs(patch.runtimePrefs)
  }
  if (patch?.autoApprove && typeof patch.autoApprove === 'object') {
    next.autoApprove = normalizeAutoApprove({ ...current.autoApprove, ...patch.autoApprove })
  }
  if (patch?.currentAccounts && typeof patch.currentAccounts === 'object') {
    next.currentAccounts = normalizeCurrentAccounts(patch.currentAccounts)
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

/**
 * Create a new account with an isolated config dir under userData/accounts.
 * Claude's live directly in accounts/<id> (where existing ones already are);
 * the other CLIs get accounts/<provider>/<id>. Ids are unique across all
 * providers, so one id always means one account.
 */
export function addAccount(label: string, provider: AccountProvider = 'claude'): Account {
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
  const configDir = provider === 'claude' ? join(accountsRoot(), id) : join(accountsRoot(), provider, id)
  try {
    mkdirSync(configDir, { recursive: true })
  } catch {
    /* dir may already exist */
  }
  const account: Account = { id, label: name, provider, configDir }
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
    currentAccounts: Object.fromEntries(
      Object.entries(s.currentAccounts).map(([p, cur]) => [p, cur === id ? null : cur])
    ),
    groups: s.groups.map((g) => (g.accountId === id ? { ...g, accountId: 'default' } : g))
  })
}

/** Select `id` (null = the CLI's default dir) as the current account of `provider`. */
export function setCurrentAccount(id: string | null, provider: AccountProvider = 'claude'): AppSettings {
  const s = load()
  const valid = id === null || s.accounts.some((a) => a.id === id && a.provider === provider)
  const next = valid ? id : null
  if (provider === 'claude') return persist({ ...s, currentAccountId: next })
  return persist({ ...s, currentAccounts: { ...s.currentAccounts, [provider]: next } })
}

/** The account id a new `provider` session uses when none is given explicitly. */
export function currentAccountFor(provider: AccountProvider): string | null {
  const s = load()
  return provider === 'claude' ? s.currentAccountId : (s.currentAccounts[provider] ?? null)
}

/**
 * Resolve the config dir for a given account selector of `provider`.
 * `null`, 'default', an unknown id, or another CLI's account → undefined (use
 * the CLI's built-in default). The provider check matters: a group's bound
 * account is a Claude account, and must never be handed to Codex as CODEX_HOME.
 * Ensures the target dir exists before returning it.
 */
export function resolveAccountDir(
  provider: AccountProvider,
  accountId: string | null | undefined
): string | undefined {
  if (!accountId || accountId === 'default') return undefined
  const account = load().accounts.find((a) => a.id === accountId && a.provider === provider)
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

/** Claude's CLAUDE_CONFIG_DIR for an account selector — see resolveAccountDir. */
export function resolveClaudeConfigDir(accountId: string | null | undefined): string | undefined {
  return resolveAccountDir('claude', accountId)
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
