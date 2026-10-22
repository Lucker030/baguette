// Shared types used by both the main and renderer processes.

export type Provider = 'claude' | 'codex' | 'copilot' | 'shell'

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
  /** Explicit command override; main-filled only, never accepted from the renderer. */
  command?: string
  commandArgs?: string[]
  /** How to hook into the CLI's conversation history. Defaults to `{kind:'new'}`. */
  launch?: SessionLaunch
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

/** A named Claude account = an isolated CLAUDE_CONFIG_DIR (config + credentials). */
export interface Account {
  id: string
  label: string
  /** Absolute path used as CLAUDE_CONFIG_DIR for sessions on this account. */
  configDir: string
}

export interface AppSettings {
  /** Default working directory for new sessions. */
  defaultCwd: string
  /** Extra Claude accounts (the built-in `~/.claude` default is implicit). */
  accounts: Account[]
  /** Currently selected account id, or null for the built-in default. */
  currentAccountId: string | null
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
  /** xterm font size in px, shared by every terminal. */
  terminalFontSize: number
  /**
   * Folder the app looks in for a newer `Local Platform Setup <ver>.exe`
   * — a local path or a network share. Empty string = update checks off.
   * There is no online feed; this is the whole "update server".
   */
  updateDir: string
  /** Check `updateDir` shortly after launch and every few hours after that. */
  checkUpdatesOnLaunch: boolean
}

/** Outcome of scanning `updateDir` — see main/updater.ts. */
export interface UpdateCheckResult {
  currentVersion: string
  /** Newest installer version found that is greater than currentVersion, else null. */
  latestVersion: string | null
  /** Absolute path of that installer, when there is one. */
  file: string | null
  /** base64 sha512 from latest.yml when the folder has one, for verifying the copy. */
  sha512: string | null
  checkedAt: number
  /** Why the check could not complete (folder missing, unreadable...). */
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
  /** Whether the backing CLI/binary was detected on this machine. */
  available: boolean
  /** Resolved command path, when detected. */
  command?: string
  hint?: string
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
 * One entry on the daily to-do list.
 *
 * Stored flat in userData/todos.json so a Claude Code session can append to it
 * directly (see the `daily-todos` skill) — the shape is meant to be obvious to
 * hand-write, and main/todos.ts normalizes anything missing on read.
 */
export interface TodoItem {
  id: string
  /** Local calendar day, YYYY-MM-DD. */
  date: string
  text: string
  done: boolean
  /** Optional detail — e.g. the context Claude captured when assigning it. */
  note?: string
  /** Where it came from, so app-typed and assigned items are distinguishable. */
  source: 'app' | 'claude'
  createdAt: number
}

/**
 * One entry in the knowledge base.
 *
 * Stored flat in userData/knowledge.json so a Claude Code session can append
 * to it directly (see the `knowledge-capture` skill) — same convention as
 * `TodoItem`: obvious to hand-write, and main/knowledge.ts normalizes
 * anything missing on read.
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
