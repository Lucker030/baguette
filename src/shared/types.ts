// Shared types used by both the main and renderer processes.

export type Provider = 'claude' | 'codex' | 'copilot' | 'antigravity' | 'shell'

export const PROVIDERS: Provider[] = ['claude', 'codex', 'copilot', 'antigravity', 'shell']

/** Where a session's process runs: a native Windows install, or inside WSL. */
export type Runtime = 'windows' | 'wsl'

/**
 * Which install a provider uses when it can run both ways.
 * - `auto`    Windows if installed there, else WSL (the default)
 * - `windows` Windows only — unavailable if there is no Windows install
 * - `wsl`     WSL only — unavailable if WSL doesn't have it
 */
export type RuntimePref = 'auto' | 'windows' | 'wsl'

export function isRuntimePref(v: unknown): v is RuntimePref {
  return v === 'auto' || v === 'windows' || v === 'wsl'
}

export type SessionStatus = 'starting' | 'running' | 'exited' | 'error'

/**
 * How a new session should hook into the underlying CLI's own conversation
 * history. Only claude/codex honor this; other providers ignore it.
 * - `new`      全新對話（Claude 會自動指派一個固定 --session-id）
 * - `continue` 續聊這個 cwd 最近一次的對話
 * - `pick`     開 CLI 內建的存檔挑選器（claude --resume / codex resume）
 * - `resume`   精準續聊指定 id（App 還原分頁時使用；僅 Claude 可靠）
 */
export type SessionLaunch =
  | { kind: 'new' }
  | { kind: 'continue' }
  | { kind: 'pick' }
  | { kind: 'resume'; sessionId: string }

/** main → renderer: open a tab on behalf of the agent bridge (see main/agent-bridge.ts). */
export interface BridgeOpenTabRequest {
  reqId: string
  provider: Provider
  name?: string
  cwd?: string
  accountId?: string
  readOnly: boolean
  /** Switch to the new tab (the point is usually to watch it). */
  focus: boolean
}

export interface CreateSessionOptions {
  provider: Provider
  cwd?: string
  cols?: number
  rows?: number
  /**
   * Claude account to bind this session to. Omit to use the current account.
   * Pass 'default' to force the built-in `~/.claude` account.
   */
  accountId?: string
  /** Resolved by the main process; injected as CLAUDE_CONFIG_DIR for claude. */
  claudeConfigDir?: string
  /** Resolved by the main process; injected as CODEX_HOME / COPILOT_HOME for those CLIs. */
  accountDir?: string
  /** Explicit command override; main-filled only, never accepted from the renderer. */
  command?: string
  commandArgs?: string[]
  /** How to hook into the CLI's conversation history. Defaults to `{kind:'new'}`. */
  launch?: SessionLaunch
  /**
   * Start the CLI unable to change anything (plan mode / read-only sandbox).
   * Set for tabs opened by another agent through the agent bridge.
   */
  readOnly?: boolean
  /**
   * Start the CLI with its "approve everything" switch (settings.autoApprove).
   * Main-filled from settings, never taken from the renderer; ignored when
   * readOnly is set.
   */
  autoApprove?: boolean
  /**
   * Login flow only: scan early output for a Claude login URL and open it
   * directly via Electron's shell.openExternal instead of relying on the
   * CLI's own browser-launch, which is unreliable inside this app's pty.
   */
  autoOpenLoginUrl?: boolean
}

/** Emitted once when a login URL is detected in a session started with `autoOpenLoginUrl`. */
export interface LoginUrlEvent {
  id: string
  url: string
}

/**
 * Providers that support switching between named accounts, and the env var
 * each CLI reads its config + credentials directory from. CODEX_HOME verified
 * against codex-cli 0.163.0: pointed at an empty folder, `codex login status`
 * says "Not logged in" while the default dir is logged in. COPILOT_HOME
 * verified against Copilot CLI 1.0.103 in WSL: config.json, logs and
 * session-state all land in it and ~/.copilot is never created (whether the
 * sign-in follows it was not testable — that copilot had never signed in). Antigravity (`agy`)
 * is deliberately absent. Verified: it keys its config off USERPROFILE
 * (`~/.gemini`), but its sign-in is one fixed Windows Credential Manager entry
 * (`gemini:antigravity`) — run with an empty USERPROFILE it is still signed
 * in — so a per-account folder would not change which account it uses.
 */
export const ACCOUNT_PROVIDERS = ['claude', 'codex', 'copilot'] as const
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number]

export const ACCOUNT_DIR_ENV: Record<AccountProvider, string> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  copilot: 'COPILOT_HOME'
}

export function isAccountProvider(p: unknown): p is AccountProvider {
  return (ACCOUNT_PROVIDERS as readonly unknown[]).includes(p)
}

/** A named account of one CLI = an isolated config dir (config + credentials). */
export interface Account {
  id: string
  label: string
  /** Which CLI this account belongs to. Accounts saved before this field existed are Claude's. */
  provider: AccountProvider
  /** Absolute path handed to the CLI through ACCOUNT_DIR_ENV[provider]. */
  configDir: string
}

export interface AppSettings {
  /** Default working directory for new sessions. */
  defaultCwd: string
  /** Extra accounts of every CLI (each CLI's own default dir is implicit). */
  accounts: Account[]
  /** Currently selected Claude account id, or null for the built-in default. */
  currentAccountId: string | null
  /**
   * Currently selected account for the other CLIs in ACCOUNT_PROVIDERS;
   * missing/null = that CLI's default config dir. (Claude keeps using
   * currentAccountId, which groups and older settings files already rely on.)
   */
  currentAccounts: Partial<Record<AccountProvider, string | null>>
  /** Named sidebar groups for organizing sessions (names persist; sessions don't). */
  groups: SessionGroup[]
  /** Reopen the previous session tabs (auto-continue each) on app launch. */
  restoreTabs: boolean
  /**
   * Closing the window hides it to the system tray instead of quitting, so
   * every CLI session keeps running. Quit from the tray menu.
   */
  closeToTray: boolean
  /** Show a Windows notification when a background session needs attention. */
  notifyOnAttention: boolean
  /**
   * Run the local agent bridge (agent-bridge.ts): lets an AI open another CLI
   * as a visible, read-only tab and talk to it while the user watches.
   */
  agentBridge: boolean
  /** xterm font size in px, shared by every terminal. */
  terminalFontSize: number
  /** Check GitHub Releases shortly after launch and every few hours after that. */
  checkUpdatesOnLaunch: boolean
  /** Windows-vs-WSL choice per provider; missing = 'auto'. */
  runtimePrefs: Partial<Record<Provider, RuntimePref>>
  /**
   * Per provider: start its tabs with every permission request approved
   * (see AUTO_APPROVE_PROVIDERS). Read-only agent-bridge tabs are never affected.
   */
  autoApprove: Partial<Record<Provider, boolean>>
  /** LAN control (main/lan.ts): listen for paired PCs and find others. */
  lanEnabled: boolean
  /** How this PC is shown to the others; empty = the computer name. */
  lanDeviceName: string
}

/** Providers whose CLI has a switch to approve every permission request. */
export const AUTO_APPROVE_PROVIDERS: Provider[] = ['antigravity']

/** A baguette on the LAN: paired, or just heard announcing itself. */
export interface LanDevice {
  id: string
  name: string
  address?: string
  port?: number
  paired: boolean
  online: boolean
  /** Paired only: this PC lets it open writable tabs here. */
  allowWrite?: boolean
  /** Paired only: this PC lets it run PowerShell here directly. */
  allowShell?: boolean
  version?: string
  /** Paired only: what each side ticked for syncing (main/lan-sync.ts). */
  sync?: Record<SyncCategory, { mine: boolean; theirs: boolean }>
  /** Paired only: the latest sync run's progress. */
  syncProgress?: LanSyncProgress
}

export type SyncCategory = 'knowledge' | 'skills' | 'hooks'
export const SYNC_CATEGORIES: SyncCategory[] = ['knowledge', 'skills', 'hooks']

export interface LanSyncProgress {
  category: SyncCategory
  phase: 'scan' | 'transfer' | 'done' | 'error'
  done: number
  total: number
  error?: string
  at: number
}

export interface LanStatus {
  running: boolean
  deviceId: string
  deviceName: string
  port?: number
  /** This PC's IPv4 addresses, for typing in on the other side. */
  addresses: string[]
  /** The code shown while this PC accepts pairing. */
  pairing: { code: string; expiresAt: number } | null
  error?: string
}

export interface LanState {
  status: LanStatus
  devices: LanDevice[]
}

/** How an AI CLI launches the MCP server (main/mcp.ts) with this baguette's own exe. */
export interface McpInfo {
  exe: string
  script: string
  bridgeFile: string
  /** The MCP server talks to the local agent bridge, so it needs to be on. */
  bridgeOn: boolean
}

/** A bridge tab on a paired PC, as its bridge describes it (agent-bridge.ts describe()). */
export interface LanRemoteTab {
  id: string
  provider: Provider
  name: string
  status: string
  readOnly: boolean
  exited: boolean
  screen?: string
}

/** Outcome of asking GitHub Releases for a newer build — see main/updater.ts. */
export interface UpdateCheckResult {
  currentVersion: string
  /** Version of the newest release installer if it is greater than currentVersion, else null. */
  latestVersion: string | null
  /** Download URL of that installer, when there is one. */
  url: string | null
  /** Asset name of that installer (`baguette-Setup-<ver>.exe`). */
  fileName: string | null
  /** Size GitHub lists for the asset, checked against the download. */
  size: number | null
  /** base64 sha512 from the release's latest.yml, for verifying the download. */
  sha512: string | null
  /** The Release page, for a "see what's new" link. */
  releaseUrl: string
  checkedAt: number
  /** Why the check could not complete (offline, rate-limited, no release yet...). */
  error?: string
}

export const TERMINAL_FONT_SIZE_MIN = 8
export const TERMINAL_FONT_SIZE_MAX = 32
export const TERMINAL_FONT_SIZE_DEFAULT = 13

/**
 * Why a session is flagged as needing the user.
 * - `idle`: it produced output continuously for a while and then went quiet —
 *   a CLI that finished a turn, or stopped at a prompt (e.g. a permission ask).
 * - `bell`: the process rang the terminal bell (BEL) explicitly.
 * - `login`: a Claude tab printed that it needs to be signed in again.
 */
export type AttentionReason = 'idle' | 'bell' | 'login'

export interface SessionAttentionEvent {
  id: string
  reason: AttentionReason
}

/** Emitted on transitions only: true when output starts flowing, false when it stops. */
export interface SessionBusyEvent {
  id: string
  busy: boolean
}

/** Where the app keeps its files, surfaced in 設定 so they can be found. */
export interface AppPaths {
  userData: string
  logsDir: string
  logFile: string
  /** package.json version of the running build. */
  version: string
}

/**
 * Whether the app starts with Windows, as the OS currently has it.
 *
 * `supported` is false for an unpackaged (dev) build, where registering
 * `process.execPath` would point the startup entry at electron.exe in
 * node_modules rather than at the installed app.
 */
export interface LaunchAtLoginState {
  supported: boolean
  enabled: boolean
}

/** A named sidebar group (folder) that sessions can be filed under. */
export interface SessionGroup {
  id: string
  name: string
  /**
   * Claude account this group is bound to. Every Claude session created while
   * this group is selected uses this account, regardless of whichever account
   * is globally "current" — so a "personal" group can never accidentally spin
   * up a session under the "work" account. 'default' = the built-in `~/.claude`
   * account. Groups created before this field existed fall back to 'default'.
   */
  accountId: string
}

export interface SessionInfo {
  id: string
  provider: Provider
  cwd: string
  status: SessionStatus
  /** Human readable note, e.g. why a provider CLI was not found. */
  message?: string
  /**
   * For claude sessions: the UUID the main process assigned via `--session-id`
   * (kind:'new') or reused via `--resume` (kind:'resume'). The renderer stores
   * this so the exact conversation can be restored later. Undefined for codex
   * (no id-assignment flag) and non-agent providers.
   */
  claudeSessionId?: string
  /**
   * Claude only: the CLI printed that its sign-in no longer works. Cleared
   * when it prints a successful login, or when the app restarts the tab after
   * another tab's login refreshed the account's credentials file.
   */
  authState?: 'needsLogin'
  /**
   * Started read-only (an agent-bridge tab). Never written to the restore
   * snapshot: reopened on the next launch it would come back as an ordinary,
   * writable tab that no bridge caller controls.
   */
  readOnly?: boolean
}

/** Tabs the app restarted because another tab's login refreshed their account. */
export interface SessionAuthRestartEvent {
  ids: string[]
}

/**
 * One reopenable tab, persisted to sessions.json. Restoring re-spawns a fresh
 * pty that resumes the CLI's conversation — no pty/scrollback state is saved.
 */
export interface PersistedTab {
  provider: Provider
  cwd: string
  /** Sidebar group this tab belonged to (null = 未分組). */
  groupId: string | null
  /** User-set custom tab name, if any. */
  name?: string
  /** Claude account binding, so restore reuses the same identity. */
  accountId?: string
  /** Claude only: exact conversation id to `--resume`; absent → `--continue`. */
  claudeSessionId?: string
}

/** Snapshot of all open tabs, persisted across app restarts. */
export interface SessionSnapshot {
  tabs: PersistedTab[]
  /** Index into `tabs` of the tab that was active. */
  activeIndex: number
}

export interface ProviderMeta {
  id: Provider
  label: string
  /** Whether a new session can start under the current runtime preference. */
  available: boolean
  /** Resolved command path, when detected (wsl.exe for a WSL launch). */
  command?: string
  hint?: string
  /** Which install a new session would use, when available. */
  runtime?: Runtime
  /** The Windows install found, if any (regardless of preference). */
  windowsCommand?: string
  /** Whether WSL has it: true/false, or null while that is not known yet. */
  wslAvailable: boolean | null
  /** The preference in effect. */
  pref: RuntimePref
}

export interface SkillInfo {
  id: string
  name: string
  description: string
  /** Absolute path to the skill directory. */
  path: string
  /** Which root it came from: user (~/.claude) or a project dir. */
  source: string
  hasSkillMd: boolean
}

/**
 * One entry in the knowledge base.
 *
 * Stored flat in userData/knowledge.json so a Claude Code session can append
 * to it directly (see the `knowledge-capture` skill): obvious to hand-write,
 * and main/knowledge.ts normalizes anything missing on read.
 *
 * Two kinds share one file and one panel, switched by a tab in the UI:
 * `'note'` is a freeform lesson/SOP/writeup; `'db'` documents one SQLite
 * database this machine maintains alongside knowledge.json (schema, purpose)
 * so a structured data registry doesn't get buried in prose notes.
 */
export interface KnowledgeEntry {
  id: string
  kind: 'note' | 'db'
  title: string
  /** Free-form body — notes/SOP text for 'note', schema/table description for 'db'. */
  content: string
  /** 'db' only: the SQLite filename this entry documents, e.g. "ort_test.db". */
  dbFile?: string
  /** 'db' only: where it lives, if not alongside knowledge.json. */
  dbPath?: string
  tags: string[]
  /** Where it came from, so app-typed and captured entries are distinguishable. */
  source: 'app' | 'claude'
  createdAt: number
  updatedAt: number
}

/** Claude Code hook events. matcher only applies to the two tool events. */
export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'UserPromptSubmit'
  | 'Notification'
  | 'Stop'
  | 'SubagentStop'
  | 'SessionStart'
  | 'SessionEnd'

/** Every real Claude Code hook event, for validating renderer input. */
export const HOOK_EVENTS: HookEvent[] = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Notification',
  'Stop',
  'SubagentStop',
  'SessionStart',
  'SessionEnd'
]

/** Events where a tool `matcher` is meaningful. */
export const HOOK_MATCHER_EVENTS: HookEvent[] = ['PreToolUse', 'PostToolUse']

/** Time-of-day + weekday recurrence for a 'Schedule' hook. */
export interface HookSchedule {
  /** 24h "HH:MM" local time. */
  time: string
  /** Weekdays this fires on, 0=Sun..6=Sat. Empty or all 7 = every day. */
  days: number[]
}

/**
 * A managed hook. `event` is either a real Claude Code hook event (enabled
 * ones are synced into ~/.claude/settings.json), or the pseudo-event
 * 'Schedule' — a time-based trigger with no Claude Code equivalent, backed
 * instead by a Windows Scheduled Task (see main/hooks.ts).
 */
export interface HookDef {
  id: string
  name: string
  event: HookEvent | 'Schedule'
  /** Tool matcher for PreToolUse/PostToolUse (e.g. "Bash", "Edit|Write", "*"). */
  matcher: string
  /** Shell command to run when the hook fires. */
  command: string
  enabled: boolean
  /** Only meaningful when event === 'Schedule'. */
  schedule?: HookSchedule
}
