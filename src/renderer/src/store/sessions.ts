import { create } from 'zustand'
import type {
  AccountProvider,
  AppSettings,
  AttentionReason,
  UpdateCheckResult,
  Provider,
  ProviderMeta,
  RuntimePref,
  SessionGroup,
  SessionInfo,
  SessionLaunch,
  PersistedTab
} from '@shared/types'
import {
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN
} from '@shared/types'
import { PROVIDER_UI } from '../providerUi'

type MainView =
  | 'terminal'
  | 'skills'
  | 'settings'
  | 'hooks'
  | 'todos'
  | 'knowledge'

/** How a split terminal area is divided. */
export type SplitDirection = 'row' | 'col'

/**
 * One slot in the terminal area. `null` is a pane that has been opened but has
 * no session in it yet — the user picks one from the sidebar to fill it.
 */
export type Pane = string | null

/** Record key for a group selector; '' represents the implicit "未分組" bucket. */
const groupKey = (id: string | null): string => id ?? ''

/** Guards init() against StrictMode's double-invoked mount effect. */
let initialized = false

interface AppState {
  sessions: SessionInfo[]
  activeId: string | null
  view: MainView
  providers: ProviderMeta[]
  providersLoaded: boolean
  settings: AppSettings | null
  /** Working directory for the next new session (defaults to settings.defaultCwd). */
  nextCwd: string
  /** Login URLs detected in login-flow sessions, keyed by session id. */
  loginUrls: Record<string, string>

  // ---- Groups ----------------------------------------------------------------
  /** Currently selected group; new sessions attach here. null = 未分組. */
  selectedGroupId: string | null
  /** Session id -> group id (null = 未分組). Ephemeral: sessions don't persist. */
  sessionGroupId: Record<string, string | null>
  /** Session id -> custom display name. Ephemeral: sessions don't persist. */
  sessionName: Record<string, string>
  /** Session id -> Claude conversation UUID (from --session-id/--resume), for restore. */
  sessionClaudeId: Record<string, string>
  /** Session id -> Claude account binding, so restore reuses the same identity. */
  sessionAccountId: Record<string, string>
  /** True while restore is replaying tabs, to suppress snapshot churn. */
  restoring: boolean
  /** Group key -> the session last activated within it (for one-click jump). */
  groupLastActive: Record<string, string>
  /** Group key -> collapsed in the sidebar. */
  collapsedGroups: Record<string, boolean>
  /** Transient error toasts, e.g. surfaced from a rejected IPC call. */
  toasts: { id: string; message: string }[]
  /**
   * True while a session is being spawned. Launch controls disable on it:
   * spawning goes through a WSL login shell and is slow enough that an
   * impatient second click lands first, which for the 登入 flow means two tabs
   * racing an OAuth exchange against the same CLAUDE_CONFIG_DIR.
   */
  creating: boolean

  // ---- Split panes -----------------------------------------------------------
  /**
   * Sessions currently on screen, left-to-right or top-to-bottom. One entry is
   * the ordinary single-terminal case. Every terminal stays mounted regardless
   * (see App.tsx) — panes only decide where each one is positioned — so moving
   * a session between panes never loses its scrollback.
   */
  panes: Pane[]
  /** Index into `panes` that keyboard focus and sidebar clicks act on. */
  focusedPane: number
  splitDirection: SplitDirection

  // ---- Activity ----------------------------------------------------------------
  /** Session id -> output is currently flowing (spinner in the sidebar). */
  sessionBusy: Record<string, boolean>
  /**
   * Sessions that finished something (or rang the bell) while the user was
   * not looking at them. Cleared by looking: activating the tab, typing into
   * it, or focusing the window while it is the active tab.
   */
  attention: Record<string, AttentionReason>
  /** xterm font size for every terminal; mirrors settings.terminalFontSize. */
  terminalFontSize: number
  /**
   * Bumped by the search shortcut. The active TerminalView watches it and
   * opens its search bar — the terminal owns the xterm instance, the shortcut
   * handler doesn't.
   */
  searchRequest: number
  /** Last update-folder scan, from launch, the timer, or the 設定 button. */
  update: UpdateCheckResult | null
  /** True while the installer is being staged; the app quits on success. */
  installingUpdate: boolean

  init: () => Promise<void>
  createSession: (
    provider: Provider,
    opts?: {
      accountId?: string
      autoOpenLoginUrl?: boolean
      /** How to hook into the CLI's history; defaults to a brand-new conversation. */
      launch?: SessionLaunch
      /** Explicit cwd (restore); otherwise the pending nextCwd is used. */
      cwd?: string
      /** Explicit group (restore); otherwise the currently selected group. */
      groupId?: string | null
      /** Custom tab name to reattach (restore). */
      name?: string
    }
  ) => Promise<void>
  /** New-conversation / continue-last / pick-a-save wrappers used by the UI. */
  newSession: (provider: Provider) => Promise<void>
  continueSession: (provider: Provider) => Promise<void>
  pickSession: (provider: Provider) => Promise<void>
  /** Persist the current set of Claude/Codex tabs to the on-disk snapshot. */
  persistSnapshot: () => void
  closeSession: (id: string) => void
  setActive: (id: string) => void
  renameSession: (id: string, name: string) => void
  setView: (view: MainView) => void
  applyStatus: (info: SessionInfo) => void
  dismissLoginUrl: (id: string) => void

  // Group actions
  addGroup: (name: string, accountId: string) => Promise<void>
  renameGroup: (id: string, name: string) => Promise<void>
  setGroupAccount: (id: string, accountId: string) => Promise<void>
  removeGroup: (id: string) => Promise<void>
  selectGroup: (id: string | null) => void
  moveSessionToGroup: (sessionId: string, groupId: string | null) => void
  toggleGroupCollapse: (id: string | null) => void

  // Settings + accounts
  refreshSettings: () => Promise<void>
  setNextCwd: (path: string) => void
  pickNextCwd: () => Promise<void>
  saveDefaultCwd: (path: string) => Promise<void>
  setRestoreTabs: (enabled: boolean) => Promise<void>
  addAccount: (label: string, provider?: AccountProvider) => Promise<void>
  renameAccount: (id: string, label: string) => Promise<void>
  removeAccount: (id: string) => Promise<void>
  setCurrentAccount: (id: string | null, provider?: AccountProvider) => Promise<void>
  /** Choose Windows / WSL / auto for one provider, then re-detect. */
  setRuntimePref: (provider: Provider, pref: RuntimePref) => Promise<void>
  refreshProviders: () => Promise<void>

  // Toasts
  pushToast: (message: string) => void
  dismissToast: (id: string) => void

  // Split panes
  splitPane: () => void
  closePane: (index: number) => void
  focusPane: (index: number) => void
  toggleSplitDirection: () => void

  // Activity + keyboard navigation
  clearAttention: (id: string) => void
  /** Sidebar order (未分組 first, then each group in settings order). */
  orderedSessionIds: () => string[]
  activateRelative: (delta: number) => void
  activateNth: (n: number) => void
  closeActiveSession: () => void
  /** Re-spawn a tab's process in place (same conversation). */
  restartSession: (id: string) => Promise<void>
  setTerminalFontSize: (size: number) => Promise<void>
  requestSearch: () => void
  setCloseToTray: (enabled: boolean) => Promise<void>
  setNotifyOnAttention: (enabled: boolean) => Promise<void>

  // Updates
  setCheckUpdatesOnLaunch: (enabled: boolean) => Promise<void>
  checkForUpdate: () => Promise<void>
  installUpdate: () => Promise<void>
}

/** Display name for notifications and the sidebar when no custom name is set. */
export function sessionLabel(s: AppState, id: string): string {
  const custom = s.sessionName[id]
  if (custom) return custom
  const info = s.sessions.find((x) => x.id === id)
  if (!info) return id
  const nth = s.sessions.filter((x) => x.provider === info.provider).findIndex((x) => x.id === id) + 1
  return `${PROVIDER_UI[info.provider].label} #${nth}`
}

/** Whether the user is, right now, looking at this session. */
function isOnScreen(s: AppState, id: string): boolean {
  return (
    s.view === 'terminal' &&
    s.activeId === id &&
    s.panes.includes(id) &&
    typeof document !== 'undefined' &&
    document.hasFocus()
  )
}

/**
 * Put `id` into the focused pane, unless it is already on screen elsewhere —
 * in that case just move focus there, since a session can only be rendered in
 * one place (its terminal is a single mounted DOM node).
 */
function placeInFocusedPane(
  panes: Pane[],
  focusedPane: number,
  id: string
): { panes: Pane[]; focusedPane: number } {
  const existing = panes.indexOf(id)
  if (existing !== -1) return { panes, focusedPane: existing }
  if (panes.length === 0) return { panes: [id], focusedPane: 0 }
  const next = [...panes]
  const target = Math.min(focusedPane, next.length - 1)
  next[target] = id
  return { panes: next, focusedPane: target }
}

export const useApp = create<AppState>((set, get) => ({
  sessions: [],
  activeId: null,
  view: 'terminal',
  providers: [],
  providersLoaded: false,
  settings: null,
  nextCwd: '',
  loginUrls: {},
  selectedGroupId: null,
  sessionGroupId: {},
  sessionName: {},
  sessionClaudeId: {},
  sessionAccountId: {},
  restoring: false,
  groupLastActive: {},
  collapsedGroups: {},
  toasts: [],
  creating: false,
  panes: [],
  focusedPane: 0,
  splitDirection: 'row',
  sessionBusy: {},
  attention: {},
  terminalFontSize: TERMINAL_FONT_SIZE_DEFAULT,
  searchRequest: 0,
  update: null,
  installingUpdate: false,

  init: async () => {
    // React StrictMode double-invokes mount effects in development. Without
    // this guard that replays the whole tab snapshot twice, spawning a second
    // WSL `claude` per restored tab and duplicating every conversation.
    if (initialized) return
    initialized = true

    const [providers, settings] = await Promise.all([
      window.api.listProviders(),
      window.api.getSettings()
    ])
    set({
      providers,
      providersLoaded: true,
      settings,
      nextCwd: settings.defaultCwd,
      terminalFontSize: settings.terminalFontSize ?? TERMINAL_FONT_SIZE_DEFAULT
    })

    // A WSL-only CLI can come back "unavailable" from a probe that failed
    // without an answer (a very slow cold start); main does not cache that,
    // so ask again a few times instead of showing 未偵測到 for the whole run.
    const recheck = (attempt: number): void => {
      // Also while WSL's answer is still unknown, so 設定 fills in that column.
      const missing = get().providers.some((p) => (!p.available && p.id !== 'shell') || p.wslAvailable === null)
      if (!missing || attempt > 3) return
      window.setTimeout(() => {
        void window.api
          .listProviders()
          .then((next) => {
            set({ providers: next })
            recheck(attempt + 1)
          })
          .catch(() => {})
      }, 15_000)
    }
    recheck(1)

    // Reflect PTY lifecycle pushed from the main process.
    window.api.onStatus((info) => get().applyStatus(info))
    window.api.onExit(({ id }) => {
      set((s) => ({
        sessions: s.sessions.map((x) =>
          x.id === id ? { ...x, status: 'exited' as const } : x
        )
      }))
    })
    window.api.onLoginUrl(({ id, url }) => {
      set((s) => ({ loginUrls: { ...s.loginUrls, [id]: url } }))
    })
    window.api.onBusy?.(({ id, busy }) => {
      set((s) => ({ sessionBusy: { ...s.sessionBusy, [id]: busy } }))
    })
    window.api.onAttention?.(({ id, reason }) => {
      const s = get()
      if (!s.sessions.some((x) => x.id === id)) return
      // The tab the user is looking at can't be "unnoticed".
      if (isOnScreen(s, id)) return
      set({ attention: { ...s.attention, [id]: reason } })
      const label = sessionLabel(s, id)
      const body =
        reason === 'bell'
          ? '終端響鈴了'
          : reason === 'login'
            ? '登入已失效。在任一分頁 /login 後，其他卡住的分頁會自動重啟'
            : '已停下來，可能在等你回覆或確認'
      window.api.notifyAttention?.(id, `${label} 需要你`, body)
    })
    window.api.onAuthRestart?.(({ ids }) => {
      get().pushToast(`偵測到新的登入，已重啟 ${ids.length} 個卡在登入的分頁。`)
    })
    window.api.onActivateRequest?.((id) => {
      if (get().sessions.some((x) => x.id === id)) get().setActive(id)
    })
    window.api.onAppError?.((message) => get().pushToast(message))
    window.api.onUpdateResult?.((result) => {
      const previous = get().update
      set({ update: result })
      // Say it once per version, not on every six-hourly re-check.
      if (result.latestVersion && result.latestVersion !== previous?.latestVersion) {
        get().pushToast(`有新版本 ${result.latestVersion}（目前 ${result.currentVersion}），到「設定 → 更新」安裝。`)
      }
    })

    // The renderer was reloaded (a crash, or a manual reload) while the main
    // process — and every pty in it — kept running. Adopt those sessions
    // instead of replaying the snapshot, which would spawn each one a second
    // time. Names and groups are renderer state and are lost; the sessions
    // themselves, with their scrollback, are not.
    let live: SessionInfo[]
    try {
      live = (await window.api.listSessions?.()) ?? []
    } catch {
      live = []
    }
    if (live.length > 0) {
      const sessionClaudeId: Record<string, string> = {}
      const sessionGroupId: Record<string, string | null> = {}
      for (const info of live) {
        if (info.claudeSessionId) sessionClaudeId[info.id] = info.claudeSessionId
        sessionGroupId[info.id] = null
      }
      const activeId = live[live.length - 1].id
      set({ sessions: live, activeId, panes: [activeId], focusedPane: 0, sessionClaudeId, sessionGroupId })
      get().pushToast('介面已重新載入，接回了仍在執行的 session。')
      return
    }

    // Reopen last session's tabs (each auto-continues its own CLI history).
    if (settings.restoreTabs) {
      let snap
      try {
        snap = await window.api.getSessionSnapshot()
      } catch {
        snap = null
      }
      if (snap && snap.tabs.length) {
        set({ restoring: true })
        try {
          for (const tab of snap.tabs) {
            // Resume by the tab's own captured id when we have one (see
            // pty-manager.ts's discoverClaudeSessionId — it reads back
            // Claude's real generated id after the fact, since an id WE
            // invent up front isn't honored under this machine's WSL
            // fallback). Without one, fall back to --continue (most-recent
            // conversation for that cwd+account) — which is also what
            // multiple tabs sharing one cwd collide on if none of them
            // happened to capture an id yet.
            //
            // Per-tab catch: one tab whose folder was renamed or lives on a
            // disconnected drive must not abort the tabs after it.
            try {
              await get().createSession(tab.provider, {
                launch: tab.claudeSessionId
                  ? { kind: 'resume', sessionId: tab.claudeSessionId }
                  : { kind: 'continue' },
                cwd: tab.cwd || undefined,
                groupId: tab.groupId,
                name: tab.name,
                accountId: tab.accountId
              })
            } catch (e) {
              get().pushToast(
                `無法還原分頁${tab.cwd ? `（${tab.cwd}）` : ''}：${(e as Error).message ?? e}`
              )
            }
          }
        } finally {
          // Must run even if something above threw: leaving `restoring` true
          // makes persistSnapshot a permanent no-op, so nothing the user does
          // for the rest of the run would ever be saved.
          set({ restoring: false })
        }
        const target = get().sessions[snap.activeIndex]
        if (target) set({ activeId: target.id })
        get().persistSnapshot()
      }
    }
  },

  createSession: async (provider, opts) => {
    const { nextCwd, selectedGroupId, settings } = get()
    // Restore may pin an explicit group; otherwise attach to the selected one.
    const targetGroup = opts && 'groupId' in opts ? (opts.groupId ?? null) : selectedGroupId
    // A group's bound account always wins over the globally "current" account,
    // so a session started while a "personal" group is selected can never end
    // up running under the "work" identity just because that happened to be
    // selected in the top bar. An explicitly passed accountId (e.g. the Claude
    // accounts screen's own "登入" button, or a restored tab) still takes
    // precedence over that.
    const group = targetGroup
      ? (settings?.groups ?? []).find((g) => g.id === targetGroup)
      : null
    const accountId = opts?.accountId ?? group?.accountId
    set({ creating: true })
    let info
    try {
      info = await window.api.createSession({
        provider,
        cwd: opts?.cwd ?? (nextCwd || undefined),
        accountId,
        autoOpenLoginUrl: opts?.autoOpenLoginUrl,
        launch: opts?.launch
      })
    } finally {
      set({ creating: false })
    }
    set((s) => {
      const sessionClaudeId = { ...s.sessionClaudeId }
      if (info.claudeSessionId) sessionClaudeId[info.id] = info.claudeSessionId
      const sessionAccountId = { ...s.sessionAccountId }
      if (accountId) sessionAccountId[info.id] = accountId
      const sessionName = { ...s.sessionName }
      if (opts?.name) sessionName[info.id] = opts.name
      const placed = placeInFocusedPane(s.panes, s.focusedPane, info.id)
      return {
        sessions: [...s.sessions, info],
        activeId: info.id,
        view: 'terminal',
        ...placed,
        sessionGroupId: { ...s.sessionGroupId, [info.id]: targetGroup },
        sessionClaudeId,
        sessionAccountId,
        sessionName,
        groupLastActive: { ...s.groupLastActive, [groupKey(targetGroup)]: info.id },
        collapsedGroups: { ...s.collapsedGroups, [groupKey(targetGroup)]: false }
      }
    })
    get().persistSnapshot()
  },

  newSession: (provider) => get().createSession(provider, { launch: { kind: 'new' } }),
  continueSession: (provider) => get().createSession(provider, { launch: { kind: 'continue' } }),
  pickSession: (provider) => get().createSession(provider, { launch: { kind: 'pick' } }),

  persistSnapshot: () => {
    const s = get()
    if (s.restoring) return
    // Only agent tabs carry resumable conversation history worth restoring;
    // shell/copilot tabs are transient and skipped.
    const restorable = s.sessions.filter(
      (x) => x.provider === 'claude' || x.provider === 'codex' || x.provider === 'antigravity'
    )
    const tabs: PersistedTab[] = restorable.map((sess) => ({
      provider: sess.provider,
      cwd: sess.cwd,
      groupId: s.sessionGroupId[sess.id] ?? null,
      name: s.sessionName[sess.id],
      accountId: s.sessionAccountId[sess.id],
      claudeSessionId: s.sessionClaudeId[sess.id]
    }))
    const activeIndex = Math.max(
      0,
      restorable.findIndex((x) => x.id === s.activeId)
    )
    void window.api.saveSessionSnapshot({ tabs, activeIndex })
  },

  closeSession: (id) => {
    window.api.killSession(id)
    set((s) => {
      const sessions = s.sessions.filter((x) => x.id !== id)
      let activeId = s.activeId
      if (activeId === id) {
        activeId = sessions.length ? sessions[sessions.length - 1].id : null
      }
      const loginUrls = { ...s.loginUrls }
      delete loginUrls[id]
      const sessionGroupId = { ...s.sessionGroupId }
      delete sessionGroupId[id]
      // Drop any group->lastActive pointers that referenced the closed session.
      const groupLastActive = { ...s.groupLastActive }
      for (const k of Object.keys(groupLastActive)) {
        if (groupLastActive[k] === id) delete groupLastActive[k]
      }
      const sessionName = { ...s.sessionName }
      delete sessionName[id]
      const sessionClaudeId = { ...s.sessionClaudeId }
      delete sessionClaudeId[id]
      const sessionAccountId = { ...s.sessionAccountId }
      delete sessionAccountId[id]
      const attention = { ...s.attention }
      delete attention[id]
      const sessionBusy = { ...s.sessionBusy }
      delete sessionBusy[id]
      // Empty the pane that held it rather than collapsing the split, so the
      // layout doesn't jump around while the user is closing tabs. A pane left
      // empty shows a "pick a session" placeholder.
      let panes = s.panes.map((p) => (p === id ? null : p))
      // The only pane is empty and something else is open: show that instead.
      if (panes.length <= 1 && activeId) panes = [activeId]
      return {
        sessions,
        activeId,
        panes,
        focusedPane: Math.min(s.focusedPane, Math.max(0, panes.length - 1)),
        loginUrls,
        sessionGroupId,
        groupLastActive,
        sessionName,
        sessionClaudeId,
        sessionAccountId,
        attention,
        sessionBusy
      }
    })
    get().persistSnapshot()
  },

  setActive: (id) => {
    set((s) => {
      const gid = s.sessionGroupId[id] ?? null
      const attention = { ...s.attention }
      delete attention[id]
      return {
        activeId: id,
        view: 'terminal',
        selectedGroupId: gid,
        attention,
        ...placeInFocusedPane(s.panes, s.focusedPane, id),
        groupLastActive: { ...s.groupLastActive, [groupKey(gid)]: id }
      }
    })
    get().persistSnapshot()
  },

  renameSession: (id, name) => {
    set((s) => {
      const label = name.trim()
      const sessionName = { ...s.sessionName }
      if (label) sessionName[id] = label
      else delete sessionName[id]
      return { sessionName }
    })
    get().persistSnapshot()
  },

  setView: (view) => set({ view }),

  dismissLoginUrl: (id) =>
    set((s) => {
      const loginUrls = { ...s.loginUrls }
      delete loginUrls[id]
      return { loginUrls }
    }),

  applyStatus: (info) => {
    // A claudeSessionId can arrive well after creation — discoverClaudeSessionId
    // (pty-manager.ts) reads it back from Claude's own transcript file once one
    // shows up, which is necessarily later than this session's initial
    // createSession() response. Capture it into sessionClaudeId (not just the
    // sessions list) and persist immediately, or the id never reaches disk and
    // this whole mechanism silently does nothing on the next restart.
    set((s) => ({
      // Replace rather than merge: `authState` and `message` are cleared by
      // being absent, and a merge would keep the stale value forever.
      sessions: s.sessions.map((x) => (x.id === info.id ? info : x)),
      sessionClaudeId: info.claudeSessionId
        ? { ...s.sessionClaudeId, [info.id]: info.claudeSessionId }
        : s.sessionClaudeId
    }))
    if (info.claudeSessionId) get().persistSnapshot()
  },

  // ---- Groups ----------------------------------------------------------------
  addGroup: async (name, accountId) => {
    const label = name.trim()
    if (!label) return
    const s = get()
    const id = `g${Date.now().toString(36)}`
    const groups: SessionGroup[] = [
      ...(s.settings?.groups ?? []),
      { id, name: label, accountId: accountId || 'default' }
    ]
    const settings = await window.api.updateSettings({ groups })
    set({ settings, selectedGroupId: id })
  },

  renameGroup: async (id, name) => {
    const label = name.trim()
    if (!label) return
    const s = get()
    const groups = (s.settings?.groups ?? []).map((g) => (g.id === id ? { ...g, name: label } : g))
    const settings = await window.api.updateSettings({ groups })
    set({ settings })
  },

  setGroupAccount: async (id, accountId) => {
    const s = get()
    const groups = (s.settings?.groups ?? []).map((g) => (g.id === id ? { ...g, accountId } : g))
    const settings = await window.api.updateSettings({ groups })
    set({ settings })
  },

  removeGroup: async (id) => {
    const s = get()
    const groups = (s.settings?.groups ?? []).filter((g) => g.id !== id)
    const settings = await window.api.updateSettings({ groups })
    // Orphaned sessions fall back to 未分組.
    const sessionGroupId = { ...s.sessionGroupId }
    for (const sid of Object.keys(sessionGroupId)) {
      if (sessionGroupId[sid] === id) sessionGroupId[sid] = null
    }
    const groupLastActive = { ...s.groupLastActive }
    delete groupLastActive[groupKey(id)]
    const collapsedGroups = { ...s.collapsedGroups }
    delete collapsedGroups[groupKey(id)]
    set({
      settings,
      sessionGroupId,
      groupLastActive,
      collapsedGroups,
      selectedGroupId: s.selectedGroupId === id ? null : s.selectedGroupId
    })
  },

  // Click a group: select it and jump straight to its last-used session (no
  // manual tab switching). Empty group just becomes the target for new sessions.
  selectGroup: (id) =>
    set((s) => {
      const members = s.sessions.filter((x) => (s.sessionGroupId[x.id] ?? null) === id)
      const remembered = s.groupLastActive[groupKey(id)]
      const target =
        (remembered && members.some((m) => m.id === remembered) && remembered) ||
        members[members.length - 1]?.id ||
        null
      return {
        selectedGroupId: id,
        view: 'terminal',
        activeId: target ?? s.activeId,
        collapsedGroups: { ...s.collapsedGroups, [groupKey(id)]: false }
      }
    }),

  moveSessionToGroup: (sessionId, groupId) => {
    set((s) => ({
      sessionGroupId: { ...s.sessionGroupId, [sessionId]: groupId },
      collapsedGroups: { ...s.collapsedGroups, [groupKey(groupId)]: false }
    }))
    get().persistSnapshot()
  },

  toggleGroupCollapse: (id) =>
    set((s) => ({
      collapsedGroups: { ...s.collapsedGroups, [groupKey(id)]: !s.collapsedGroups[groupKey(id)] }
    })),

  // ---- Settings + accounts ----------------------------------------------------
  refreshSettings: async () => {
    const settings = await window.api.getSettings()
    set({ settings })
  },

  setNextCwd: (path) => set({ nextCwd: path }),

  pickNextCwd: async () => {
    const dir = await window.api.pickDirectory()
    if (dir) set({ nextCwd: dir })
  },

  saveDefaultCwd: async (path) => {
    const settings = await window.api.updateSettings({ defaultCwd: path })
    set({ settings, nextCwd: path })
  },

  setRestoreTabs: async (enabled) => {
    const settings = await window.api.updateSettings({ restoreTabs: enabled })
    set({ settings })
  },

  addAccount: async (label, provider) => {
    await window.api.addAccount(label, provider)
    await get().refreshSettings()
  },

  renameAccount: async (id, label) => {
    const settings = await window.api.renameAccount(id, label)
    set({ settings })
  },

  removeAccount: async (id) => {
    const settings = await window.api.removeAccount(id)
    set({ settings })
  },

  setCurrentAccount: async (id, provider) => {
    const settings = await window.api.setCurrentAccount(id, provider)
    set({ settings })
  },

  setRuntimePref: async (provider, pref) => {
    const current = get().settings?.runtimePrefs ?? {}
    const settings = await window.api.updateSettings({ runtimePrefs: { ...current, [provider]: pref } })
    set({ settings })
    // Availability, the command and the hint all depend on the preference.
    await get().refreshProviders()
  },

  refreshProviders: async () => {
    try {
      set({ providers: await window.api.listProviders() })
    } catch (e) {
      window.api.log('warn', `listProviders failed: ${(e as Error).message}`)
    }
  },

  // ---- Toasts ------------------------------------------------------------------
  pushToast: (message) => {
    const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    set((s) => ({ toasts: [...s.toasts, { id, message }] }))
    setTimeout(() => get().dismissToast(id), 6000)
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  // ---- Split panes -------------------------------------------------------------
  splitPane: () =>
    set((s) => {
      // Seed the new pane with a session that isn't already on screen; a
      // session can only live in one pane, so otherwise it opens empty and
      // waits for the user to click a tab.
      const shown = new Set(s.panes.filter((p): p is string => p !== null))
      const candidate = s.sessions.find((x) => !shown.has(x.id))?.id ?? null
      const panes = [...s.panes]
      // No panes yet (no sessions at all): nothing meaningful to split.
      if (panes.length === 0) return {}
      const at = Math.min(s.focusedPane, panes.length - 1) + 1
      panes.splice(at, 0, candidate)
      return {
        panes,
        focusedPane: at,
        activeId: candidate ?? s.activeId,
        view: 'terminal'
      }
    }),

  closePane: (index) =>
    set((s) => {
      // Closing a pane only changes the layout — the session keeps running and
      // stays in the sidebar. Use the tab's ✕ to actually end it.
      if (s.panes.length <= 1) return {}
      const panes = s.panes.filter((_, i) => i !== index)
      const focusedPane = Math.min(s.focusedPane, panes.length - 1)
      return { panes, focusedPane, activeId: panes[focusedPane] ?? s.activeId }
    }),

  focusPane: (index) =>
    set((s) => {
      if (index < 0 || index >= s.panes.length) return {}
      const activeId = s.panes[index] ?? s.activeId
      const attention = { ...s.attention }
      if (activeId) delete attention[activeId]
      return { focusedPane: index, activeId, attention }
    }),

  toggleSplitDirection: () =>
    set((s) => ({ splitDirection: s.splitDirection === 'row' ? 'col' : 'row' })),

  // ---- Activity + keyboard navigation ---------------------------------------------
  clearAttention: (id) =>
    set((s) => {
      if (!(id in s.attention)) return {}
      const attention = { ...s.attention }
      delete attention[id]
      return { attention }
    }),

  orderedSessionIds: () => {
    const s = get()
    const buckets: (string | null)[] = [null, ...(s.settings?.groups ?? []).map((g) => g.id)]
    const out: string[] = []
    for (const b of buckets) {
      for (const x of s.sessions) if ((s.sessionGroupId[x.id] ?? null) === b) out.push(x.id)
    }
    // Sessions filed under a group that no longer exists still need a slot.
    for (const x of s.sessions) if (!out.includes(x.id)) out.push(x.id)
    return out
  },

  activateRelative: (delta) => {
    const s = get()
    const order = s.orderedSessionIds()
    if (order.length === 0) return
    const at = s.activeId ? order.indexOf(s.activeId) : -1
    const next = at === -1 ? 0 : (at + delta + order.length) % order.length
    s.setActive(order[next])
  },

  activateNth: (n) => {
    const order = get().orderedSessionIds()
    const id = order[n - 1]
    if (id) get().setActive(id)
  },

  closeActiveSession: () => {
    const { activeId, view } = get()
    if (view === 'terminal' && activeId) get().closeSession(activeId)
  },

  restartSession: async (id) => {
    const info = await window.api.restartSession(id)
    if (info) get().applyStatus(info)
  },

  setTerminalFontSize: async (size) => {
    const clamped = Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(size)))
    if (clamped === get().terminalFontSize) return
    // Apply immediately so zooming feels instant; the settings write catches up.
    set({ terminalFontSize: clamped })
    const settings = await window.api.updateSettings({ terminalFontSize: clamped })
    set({ settings })
  },

  requestSearch: () => set((s) => ({ searchRequest: s.searchRequest + 1 })),

  setCloseToTray: async (enabled) => {
    const settings = await window.api.updateSettings({ closeToTray: enabled })
    set({ settings })
  },

  setNotifyOnAttention: async (enabled) => {
    const settings = await window.api.updateSettings({ notifyOnAttention: enabled })
    set({ settings })
  },

  // ---- Updates -------------------------------------------------------------------
  setCheckUpdatesOnLaunch: async (enabled) => {
    const settings = await window.api.updateSettings({ checkUpdatesOnLaunch: enabled })
    set({ settings })
  },

  checkForUpdate: async () => {
    const result = await window.api.checkForUpdate()
    set({ update: result })
  },

  installUpdate: async () => {
    set({ installingUpdate: true })
    try {
      await window.api.installUpdate()
      // On success the app is quitting; nothing more to render.
    } catch (e) {
      set({ installingUpdate: false })
      get().pushToast(`無法安裝更新：${(e as Error).message ?? e}`)
    }
  }
}))
