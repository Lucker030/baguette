import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type {
  CreateSessionOptions,
  SessionInfo,
  ProviderMeta,
  SkillInfo,
  HookDef,
  Account,
  AccountProvider,
  AppPaths,
  AppSettings,
  LoginUrlEvent,
  SessionSnapshot,
  KnowledgeEntry,
  LaunchAtLoginState,
  SessionAttentionEvent,
  SessionAuthRestartEvent,
  SessionBusyEvent,
  TodoItem,
  UpdateCheckResult
} from '../shared/types'

type Unsubscribe = () => void

function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  listProviders: (): Promise<ProviderMeta[]> => ipcRenderer.invoke('providers:list'),

  // Skills
  listSkills: (): Promise<SkillInfo[]> => ipcRenderer.invoke('skills:list'),
  createSkill: (name: string, description: string): Promise<SkillInfo> =>
    ipcRenderer.invoke('skills:create', name, description),

  // Settings + Claude accounts
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:update', patch),
  getLaunchAtLogin: (): Promise<LaunchAtLoginState> =>
    ipcRenderer.invoke('settings:getLaunchAtLogin'),
  setLaunchAtLogin: (enabled: boolean): Promise<LaunchAtLoginState> =>
    ipcRenderer.invoke('settings:setLaunchAtLogin', enabled),
  addAccount: (label: string, provider?: AccountProvider): Promise<Account> =>
    ipcRenderer.invoke('accounts:add', label, provider),
  renameAccount: (id: string, label: string): Promise<AppSettings> =>
    ipcRenderer.invoke('accounts:rename', id, label),
  removeAccount: (id: string): Promise<AppSettings> => ipcRenderer.invoke('accounts:remove', id),
  setCurrentAccount: (id: string | null, provider?: AccountProvider): Promise<AppSettings> =>
    ipcRenderer.invoke('accounts:setCurrent', id, provider),

  // App housekeeping
  getAppPaths: (): Promise<AppPaths> => ipcRenderer.invoke('app:paths'),
  openAppPath: (target: 'userData' | 'logs'): Promise<string> =>
    ipcRenderer.invoke('app:openPath', target),
  /** Append to the main-process log file (renderer crashes, rejected IPC). */
  log: (level: 'info' | 'warn' | 'error', message: string): void =>
    ipcRenderer.send('app:log', level, message),
  /**
   * Ask main to raise an OS notification for a session that needs the user.
   * Main only does so when the window isn't in front — see index.ts.
   */
  notifyAttention: (sessionId: string, title: string, body: string): void =>
    ipcRenderer.send('app:notifyAttention', sessionId, title, body),
  /** Main-process errors that were caught and logged, surfaced as a toast. */
  onAppError: (cb: (message: string) => void): Unsubscribe => subscribe('app:error', cb),

  // Updates from GitHub Releases — see main/updater.ts.
  checkForUpdate: (): Promise<UpdateCheckResult> => ipcRenderer.invoke('update:check'),
  /** Downloads, verifies, launches the installer and quits; rejects if it can't. */
  installUpdate: (): Promise<void> => ipcRenderer.invoke('update:install'),
  /** Open the project's GitHub Releases page in the browser. */
  openReleasePage: (): Promise<void> => ipcRenderer.invoke('update:openReleasePage'),
  /** Result of a scheduled (launch / periodic) check. */
  onUpdateResult: (cb: (r: UpdateCheckResult) => void): Unsubscribe =>
    subscribe('update:result', cb),
  /** The user clicked a notification: switch to that session. */
  onActivateRequest: (cb: (sessionId: string) => void): Unsubscribe =>
    subscribe('session:activateRequest', cb),

  // Hook 庫
  listHooks: (): Promise<HookDef[]> => ipcRenderer.invoke('hooks:list'),
  createHook: (input: Omit<HookDef, 'id'>): Promise<HookDef[]> =>
    ipcRenderer.invoke('hooks:create', input),
  updateHook: (id: string, patch: Partial<Omit<HookDef, 'id'>>): Promise<HookDef[]> =>
    ipcRenderer.invoke('hooks:update', id, patch),
  removeHook: (id: string): Promise<HookDef[]> => ipcRenderer.invoke('hooks:remove', id),
  setHookEnabled: (id: string, enabled: boolean): Promise<HookDef[]> =>
    ipcRenderer.invoke('hooks:setEnabled', id, enabled),

  // 每日代辦事項
  listTodos: (): Promise<TodoItem[]> => ipcRenderer.invoke('todos:list'),
  addTodos: (texts: string[], date?: string): Promise<TodoItem[]> =>
    ipcRenderer.invoke('todos:add', texts, date),
  setTodoDone: (id: string, done: boolean): Promise<TodoItem[]> =>
    ipcRenderer.invoke('todos:setDone', id, done),
  updateTodoText: (id: string, text: string): Promise<TodoItem[]> =>
    ipcRenderer.invoke('todos:updateText', id, text),
  removeTodo: (id: string): Promise<TodoItem[]> => ipcRenderer.invoke('todos:remove', id),
  clearDoneTodos: (): Promise<TodoItem[]> => ipcRenderer.invoke('todos:clearDone'),
  todosFilePath: (): Promise<string> => ipcRenderer.invoke('todos:path'),
  /** Fires when todos.json changes on disk — e.g. a Claude session assigned some. */
  onTodosChanged: (cb: (items: TodoItem[]) => void): Unsubscribe =>
    subscribe('todos:changed', cb),

  listKnowledge: (): Promise<KnowledgeEntry[]> => ipcRenderer.invoke('knowledge:list'),
  addKnowledge: (
    fields: Partial<Pick<KnowledgeEntry, 'kind' | 'title' | 'content' | 'dbFile' | 'dbPath' | 'tags'>>
  ): Promise<KnowledgeEntry[]> => ipcRenderer.invoke('knowledge:add', fields),
  updateKnowledge: (
    id: string,
    patch: Partial<Pick<KnowledgeEntry, 'kind' | 'title' | 'content' | 'dbFile' | 'dbPath' | 'tags'>>
  ): Promise<KnowledgeEntry[]> => ipcRenderer.invoke('knowledge:update', id, patch),
  removeKnowledge: (id: string): Promise<KnowledgeEntry[]> =>
    ipcRenderer.invoke('knowledge:remove', id),
  knowledgeFilePath: (): Promise<string> => ipcRenderer.invoke('knowledge:path'),
  /** Fires when knowledge.json changes on disk — e.g. a Claude session captured a note. */
  onKnowledgeChanged: (cb: (items: KnowledgeEntry[]) => void): Unsubscribe =>
    subscribe('knowledge:changed', cb),

  // Native dialogs
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickDirectory'),

  // Clipboard (bypasses the renderer's own clipboard permissions for reliable paste/copy)
  readClipboardText: (): Promise<string> => ipcRenderer.invoke('clipboard:readText'),
  writeClipboardText: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:writeText', text),
  /** Clipboard image spilled to a temp PNG, or null if there isn't one. */
  readClipboardImageAsFile: (): Promise<string | null> =>
    ipcRenderer.invoke('clipboard:readImageAsFile'),

  /**
   * Absolute path of a dropped File. `File.path` was removed from Electron, so
   * this is the supported replacement — and it has to live in the preload
   * because webUtils is not exposed to a sandboxed renderer.
   */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  // Sessions
  createSession: (opts: CreateSessionOptions): Promise<SessionInfo> =>
    ipcRenderer.invoke('session:create', opts),
  listSessions: (): Promise<SessionInfo[]> => ipcRenderer.invoke('session:list'),
  /** Mark this session's terminal as ready and get any output it missed. */
  attachSession: (id: string): Promise<string> => ipcRenderer.invoke('session:attach', id),
  writeSession: (id: string, data: string): void => ipcRenderer.send('session:write', id, data),
  resizeSession: (id: string, cols: number, rows: number): void =>
    ipcRenderer.send('session:resize', id, cols, rows),
  killSession: (id: string): void => ipcRenderer.send('session:kill', id),
  /** Re-spawn the process in place, resuming the same conversation. */
  restartSession: (id: string): Promise<SessionInfo | null> =>
    ipcRenderer.invoke('session:restart', id),

  // Open-tab snapshot (restore tabs across app restarts)
  getSessionSnapshot: (): Promise<SessionSnapshot> => ipcRenderer.invoke('sessions:getSnapshot'),
  saveSessionSnapshot: (snap: SessionSnapshot): Promise<void> =>
    ipcRenderer.invoke('sessions:saveSnapshot', snap),

  onData: (cb: (p: { id: string; data: string }) => void): Unsubscribe =>
    subscribe('session:data', cb),
  onExit: (cb: (p: { id: string; code: number }) => void): Unsubscribe =>
    subscribe('session:exit', cb),
  onStatus: (cb: (info: SessionInfo) => void): Unsubscribe => subscribe('session:status', cb),
  onLoginUrl: (cb: (p: LoginUrlEvent) => void): Unsubscribe => subscribe('session:loginUrl', cb),
  /** Output started/stopped flowing — drives the sidebar's activity indicator. */
  onBusy: (cb: (p: SessionBusyEvent) => void): Unsubscribe => subscribe('session:busy', cb),
  /** A session went quiet after working, or rang the bell — see main/activity.ts. */
  onAttention: (cb: (p: SessionAttentionEvent) => void): Unsubscribe =>
    subscribe('session:attention', cb),
  /** Tabs that were stuck on login and got restarted after another tab signed in. */
  onAuthRestart: (cb: (p: SessionAuthRestartEvent) => void): Unsubscribe =>
    subscribe('session:authRestart', cb)
}

export type BaguetteApi = typeof api

contextBridge.exposeInMainWorld('api', api)
