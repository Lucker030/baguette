import { app, BrowserWindow, ipcMain, shell, dialog, clipboard, Notification, nativeImage } from 'electron'
import type { Tray } from 'electron'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import { join } from 'node:path'
import { PtyManager } from './pty-manager'
import { AgentBridge } from './agent-bridge'
import type { BridgeCall, OpenTabRequest } from './agent-bridge'
import { listProviders, setRuntimePrefs, warmProviderCache } from './providers'
import { listSkills, createSkill } from './skills'
import { listHooks, createHook, updateHook, removeHook, setHookEnabled, applyHookChanges } from './hooks'
import { getSnapshot, saveSnapshot } from './session-store'
import { sendToRenderer } from './renderer-bridge'
import { initLog, log, logDir, logFile } from './log'
import { appIconPath, createTray } from './tray'
import { checkForUpdate, installUpdate, RELEASES_PAGE } from './updater'
import { LanNode } from './lan'
import { lanStore } from './lan-store'
import { runPowerShell } from './remote-shell'
import { LanSync, type Hashes } from './lan-sync'
import { backupFile, distributeSkills, recordAdapter, skillsAdapter } from './lan-sync-adapters'
import { writeFileAtomic } from './atomic-write'
import {
  addKnowledge,
  applyKnowledgeChanges,
  knowledgeItems,
  knowledgePath,
  listKnowledge,
  removeKnowledge,
  updateKnowledge,
  watchKnowledge
} from './knowledge'
import {
  getSettings,
  updateSettings,
  addAccount,
  renameAccount,
  removeAccount,
  setCurrentAccount,
  getLaunchAtLogin,
  setLaunchAtLogin,
  resolveClaudeConfigDir,
  resolveAccountDir,
  currentAccountFor
} from './settings'
import { isAccountProvider, PROVIDERS, SYNC_CATEGORIES } from '../shared/types'
import type {
  AppPaths,
  AppSettings,
  CreateSessionOptions,
  HookDef,
  KnowledgeEntry,
  Provider,
  SessionLaunch,
  SessionSnapshot,
  SyncCategory,
  UpdateCheckResult
} from '../shared/types'

const ptyManager = new PtyManager()
let mainWindow: BrowserWindow | null = null
let agentBridge: AgentBridge | null = null

// The bridge's server is up within a second of launch, well before the
// renderer has subscribed to 'bridge:openTab' — a request sent then is simply
// lost (verified: it timed out). It also must not mount a terminal before the
// window has laid out and the font has loaded, or the tab starts at a garbage
// size. The renderer says 'bridge:ready' once both are true; requests wait.
let markBridgeReady: () => void = () => {}
const bridgeReady = new Promise<void>((resolve) => (markBridgeReady = resolve))

/**
 * Have the renderer open a tab the same way its own buttons do — so the new
 * tab gets a sidebar entry, a group, a pane and a place in the saved
 * snapshot — and hand back the session id it got.
 */
async function openTabViaRenderer(req: OpenTabRequest): Promise<string> {
  const ready = await Promise.race([bridgeReady.then(() => true), sleepMs(60_000).then(() => false)])
  if (!ready) throw new Error('baguette 的畫面還沒準備好（視窗是否開著？）')
  return new Promise((resolve, reject) => {
    const reqId = randomUUID()
    const done = (): void => {
      clearTimeout(timer)
      ipcMain.removeListener('bridge:openTab:result', onResult)
    }
    const onResult = (_e: unknown, r: { reqId?: unknown; id?: unknown; error?: unknown }): void => {
      if (r?.reqId !== reqId) return
      done()
      if (typeof r.id === 'string') resolve(r.id)
      else reject(new Error(typeof r.error === 'string' ? r.error : '畫面沒有開出分頁'))
    }
    const timer = setTimeout(() => {
      done()
      reject(new Error('畫面 30 秒內沒有回應（視窗是否開著？）'))
    }, 30_000)
    ipcMain.on('bridge:openTab:result', onResult)
    sendToRenderer(mainWindow, 'bridge:openTab', { reqId, ...req })
  })
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Start or stop the bridge's server to match settings.agentBridge. */
function syncAgentBridge(): void {
  if (!agentBridge) {
    agentBridge = new AgentBridge({
      pty: ptyManager,
      openTab: openTabViaRenderer,
      closeTab: (id) => sendToRenderer(mainWindow, 'bridge:closeTab', { id }),
      infoFile: bridgeInfoFile(),
      lan: () => (lanNode?.running ? lanNode : null)
    })
  }
  if (getSettings().agentBridge) {
    agentBridge.start().catch((e) => log.error(`agent bridge failed to start: ${(e as Error).message}`))
  } else {
    agentBridge.stop()
  }
}

function bridgeInfoFile(): string {
  return join(app.getPath('userData'), 'agent-bridge.json')
}

// ---- LAN control (lan.ts) ----------------------------------------------------
let lanNode: LanNode | null = null

function lanDeviceName(): string {
  return getSettings().lanDeviceName || os.hostname()
}

function lanState(node: LanNode): { status: ReturnType<LanNode['status']>; devices: ReturnType<LanNode['devices']> } {
  return {
    status: node.status(),
    devices: node.devices().map((d) => (d.paired ? { ...d, syncProgress: lanSync?.progressOf(d.id) } : d))
  }
}

function sendLanState(): void {
  if (lanNode) sendToRenderer(mainWindow, 'lan:changed', lanState(lanNode))
}

// ---- LAN sync of 知識庫 / Skills / Hook 庫 (lan-sync.ts) ------------------------
let lanSync: LanSync | null = null

/** Per peer and category, the hashes both sides agreed on (lan-sync.ts "base"). */
function syncBases(): { get(peer: string, cat: SyncCategory): Hashes | null; set(peer: string, cat: SyncCategory, base: Hashes): void } {
  const file = join(app.getPath('userData'), 'lan-sync.json')
  const read = (): Record<string, Hashes> => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Record<string, Hashes>
    } catch {
      return {}
    }
  }
  // Skills moved from ~/.claude/skills to ~/.agents/skills (1.0.3): a base
  // taken over the old folder must not be read as the new one's, or an
  // unchanged-looking name could be taken for a deletion.
  const key = (peer: string, cat: SyncCategory): string => `${peer}/${cat === 'skills' ? 'skills@agents' : cat}`
  return {
    get: (peer, cat) => read()[key(peer, cat)] ?? null,
    set: (peer, cat, base) => writeFileAtomic(file, JSON.stringify({ ...read(), [key(peer, cat)]: base }))
  }
}

/** Every AI's skill folder, the same list as ~/.agents/skills/install.ps1. */
function skillTargets(): string[] {
  const home = os.homedir()
  const accounts = join(app.getPath('userData'), 'accounts')
  const targets = [
    join(home, '.claude', 'skills'), // Claude Code (default account)
    join(accounts, 'personal', 'skills'), // Claude Code (baguette personal)
    join(home, '.codex', 'skills'), // Codex (default)
    join(home, '.gemini', 'config', 'skills') // Antigravity (global)
  ]
  // Codex, each baguette account that has been set up.
  const codex = join(accounts, 'codex')
  if (existsSync(codex)) {
    for (const d of readdirSync(codex)) if (existsSync(join(codex, d, 'config.toml'))) targets.push(join(codex, d, 'skills'))
  }
  return targets
}

function createLanSync(node: LanNode): LanSync {
  const backups = join(app.getPath('userData'), 'sync-backup')
  const agentsDir = join(os.homedir(), '.agents')
  const sync = new LanSync({
    myId: () => node.deviceId,
    peers: () => node.syncPeers(),
    setMine: (id, cat, on) => node.setSyncFlag(id, cat, on),
    setTheirs: (id, flags) => node.setPeerSync(id, flags),
    request: (id, method, params) => node.request(id, method, params),
    adapters: {
      knowledge: recordAdapter<KnowledgeEntry>({
        items: knowledgeItems,
        fingerprint: (k) => k,
        write: applyKnowledgeChanges,
        asCopy: (k, id, from) => ({ ...k, id, title: `${k.title}（來自 ${from}）` }),
        backup: () => backupFile(knowledgePath(), backups)
      }),
      hooks: recordAdapter<HookDef>({
        items: listHooks,
        // Enabled is this PC's own choice: hooks arrive disabled.
        fingerprint: (h) => ({ id: h.id, name: h.name, event: h.event, matcher: h.matcher, command: h.command, schedule: h.schedule }),
        write: (put, remove) => void applyHookChanges(put, remove),
        asCopy: (h, id, from) => ({ ...h, id, name: `${h.name}（來自 ${from}）` }),
        backup: () => backupFile(join(app.getPath('userData'), 'hooks.json'), backups)
      }),
      // The user keeps skills in ~/.agents/skills and distributes them to each
      // AI from there (install.ps1), so that is what syncs; ~/.claude/skills
      // is a generated copy. Work/backups sit beside it, on the same disk.
      skills: skillsAdapter(join(agentsDir, 'skills'), join(agentsDir, '.baguette-sync'), (name, reason) =>
        log.warn(`sync: skill ${name} skipped: ${reason}`)
      )
    },
    bases: syncBases(),
    log: { info: (m) => log.info(m), warn: (m) => log.warn(m) }
  })
  sync.on('changed', sendLanState)
  // The knowledge panel ignores the file watcher for our own writes; tell it.
  sync.on('applied', (cat: SyncCategory) => {
    if (cat === 'knowledge') sendToRenderer(mainWindow, 'knowledge:changed', listKnowledge())
    if (cat === 'skills') {
      try {
        const names = distributeSkills(join(agentsDir, 'skills'), skillTargets())
        log.info(`sync: distributed skills ${names.join(', ')}`)
      } catch (e) {
        log.warn(`sync: could not distribute skills: ${(e as Error).message}`)
      }
    }
  })
  return sync
}

/** Start or stop LAN control to match settings.lanEnabled. */
function syncLan(): void {
  if (!lanNode) {
    lanNode = new LanNode({
      store: lanStore,
      deviceName: lanDeviceName,
      version: app.getVersion(),
      // syncAgentBridge runs first at startup, so the bridge exists by now;
      // exec works whether or not its local HTTP server is on.
      exec: (call, caller) => {
        if (!agentBridge) throw new Error('agent bridge unavailable')
        return agentBridge.exec(call, caller)
      },
      log: { info: (m) => log.info(m), warn: (m) => log.warn(m) },
      syncServe: (peer, method, params) => {
        if (!lanSync) throw new Error('sync unavailable')
        return lanSync.serve(peer, method, params)
      },
      shell: async (req, from) => {
        log.info(`remote shell from ${from.name} (${from.id}) in ${req.cwd ?? '(default dir)'}: ${req.command.slice(0, 500)}`)
        const r = await runPowerShell(req)
        log.info(`remote shell from ${from.name}: exit ${r.exitCode}${r.timedOut ? ' (timed out)' : ''} after ${r.durationMs}ms`)
        return r
      }
    })
    lanNode.on('changed', sendLanState)
    lanNode.on('paired', (d: { name: string }) => sendToRenderer(mainWindow, 'lan:paired', d))
    lanSync = createLanSync(lanNode)
  }
  if (getSettings().lanEnabled) {
    lanNode.start().catch((e) => log.error(`lan failed to start: ${(e as Error).message}`))
  } else {
    lanNode.stop()
  }
}

/** The MCP server script (mcp.ts), outside the asar so a plain node process can read it. */
function mcpScriptPath(): string {
  const p = join(app.getAppPath(), 'out', 'main', 'mcp.js')
  return app.isPackaged ? p.replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked') : p
}

/** What the renderer may ask of a paired PC: look at the tabs this PC opened there, or close one. */
function sanitizeLanCall(value: unknown): BridgeCall | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v.kind !== 'list' && v.kind !== 'screen' && v.kind !== 'close') return null
  return {
    kind: v.kind,
    id: typeof v.id === 'string' ? v.id.slice(0, 64) : undefined,
    body: {},
    lines: typeof v.lines === 'number' ? v.lines : undefined
  }
}
let tray: Tray | null = null
/** Set once quitting has begun, so the close handler stops hiding to tray. */
let quitting = false

// ---- Logging + crash guards ---------------------------------------------------
//
// Electron's default for an uncaught main-process exception is a modal error
// dialog followed by exit — which takes every open CLI session down with it,
// over what is usually a bug in some side feature. Log it and keep going; the
// renderer shows a toast so it is not silent either. `sendToRenderer` is
// itself guarded, so this handler cannot throw its way back in here.
initLog(() => join(app.getPath('userData'), 'logs'))

process.on('uncaughtException', (err) => {
  log.error('uncaughtException', err)
  sendToRenderer(mainWindow, 'app:error', `主程序發生錯誤（已記錄到 log）：${(err as Error)?.message ?? err}`)
})
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection', reason)
})

// ---- Validation of renderer-supplied IPC input ---------------------------------
function sanitizeProvider(value: unknown): Provider | null {
  return PROVIDERS.includes(value as Provider) ? (value as Provider) : null
}

/**
 * A resume id ends up inside a `bash -lic` payload, which is parsed as shell
 * source, so it is constrained to characters that cannot mean anything there.
 * Anything else degrades to "continue the most recent conversation" rather
 * than being passed along.
 */
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,64}$/

function sanitizeLaunch(launch: unknown): SessionLaunch | undefined {
  if (!launch || typeof launch !== 'object') return undefined
  const kind = (launch as SessionLaunch).kind
  if (kind === 'new' || kind === 'continue' || kind === 'pick') return { kind }
  if (kind === 'resume') {
    const sessionId = (launch as { sessionId?: unknown }).sessionId
    if (typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId)) {
      return { kind: 'resume', sessionId }
    }
    return { kind: 'continue' }
  }
  return undefined
}

/** Bring the window back from hidden/minimized and give it focus. */
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    title: 'baguette',
    icon: appIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // With closeToTray on, the ✕ button hides the window and every session keeps
  // running; quitting happens from the tray menu (or before-quit, e.g. OS
  // shutdown). If the tray could not be created there is nowhere to bring the
  // window back from, so fall through to a real close in that case.
  mainWindow.on('close', (e) => {
    if (quitting || !tray || !getSettings().closeToTray) return
    e.preventDefault()
    mainWindow?.hide()
  })

  // Drop the reference once the window is gone. Without this, `mainWindow`
  // keeps pointing at a destroyed BrowserWindow and every later pty event
  // throws "Object has been destroyed" out of an unguarded listener.
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Focusing the window is the user looking at it: stop flashing the taskbar.
  mainWindow.on('focus', () => mainWindow?.flashFrame(false))

  // A renderer crash used to leave a blank window with no explanation. Log it
  // and reload; the store's init() adopts the sessions that are still alive in
  // this process instead of replaying the tab snapshot, so nothing is spawned
  // twice. (See store/sessions.ts.)
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log.error(`renderer gone: ${details.reason} (exit ${details.exitCode})`)
    if (details.reason === 'clean-exit') return
    mainWindow?.webContents.reload()
  })

  // Open external links in the OS browser, not inside the app.
  //
  // Only http/https are handed to the OS. shell.openExternal will dispatch
  // whatever scheme it is given to whichever program is registered for it,
  // so an unvalidated URL here is a way to launch things. Every link in the
  // app today is one we wrote ourselves (plus whatever a CLI prints, which
  // xterm's link addon turns clickable), so the scheme allowlist stays.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ---- Forward PtyManager events to the renderer --------------------------------
// These fire from pty output, not from an IPC handler, so an exception here is
// uncaught and crashes the main process — see sendToRenderer for why a bare
// `mainWindow?.webContents.send(...)` is not a sufficient guard.
function wirePtyEvents(): void {
  ptyManager.on('data', (payload) => sendToRenderer(mainWindow, 'session:data', payload))
  ptyManager.on('exit', (payload) => sendToRenderer(mainWindow, 'session:exit', payload))
  ptyManager.on('status', (info) => sendToRenderer(mainWindow, 'session:status', info))
  ptyManager.on('login-url', (payload) => sendToRenderer(mainWindow, 'session:loginUrl', payload))
  ptyManager.on('busy', (payload) => sendToRenderer(mainWindow, 'session:busy', payload))
  ptyManager.on('attention', (payload) => sendToRenderer(mainWindow, 'session:attention', payload))
  ptyManager.on('auth-restart', (payload: { ids: string[] }) => {
    log.info(`credentials refreshed; restarted ${payload.ids.length} stuck tab(s): ${payload.ids.join(', ')}`)
    sendToRenderer(mainWindow, 'session:authRestart', payload)
  })
}

/**
 * The renderer decided a background session needs the user (it knows which
 * tab is on screen; we don't). If the window itself isn't in front, escalate
 * to the OS: a Windows toast plus a flashing taskbar button. Clicking the
 * toast brings the window up on that tab.
 */
function notifyAttention(sessionId: string, title: string, body: string): void {
  if (!getSettings().notifyOnAttention) return
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isFocused() && mainWindow.isVisible()) return
  mainWindow.flashFrame(true)
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body, icon: nativeImage.createFromPath(appIconPath()), silent: false })
  n.on('click', () => {
    showMainWindow()
    sendToRenderer(mainWindow, 'session:activateRequest', sessionId)
  })
  n.show()
}

// ---- Updates from GitHub Releases ---------------------------------------------
// Six-hourly keeps us far below the unauthenticated GitHub API limit (60/h).
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Ask GitHub for a newer release and tell the renderer what was found. */
async function runUpdateCheck(): Promise<UpdateCheckResult> {
  const result = await checkForUpdate(app.getVersion())
  if (result.error) log.warn(`update check: ${result.error}`)
  else if (result.latestVersion) log.info(`update available: ${result.latestVersion} at ${result.url}`)
  sendToRenderer(mainWindow, 'update:result', result)
  return result
}

/** A check shortly after launch (so startup isn't slowed) and then periodically. */
function scheduleUpdateChecks(): void {
  const tick = (): void => {
    if (getSettings().checkUpdatesOnLaunch) void runUpdateCheck()
  }
  setTimeout(tick, 8000)
  setInterval(tick, UPDATE_CHECK_INTERVAL_MS)
}

// ---- IPC handlers -------------------------------------------------------------
function registerIpc(): void {
  // Warm the (blocking) WSL probes off the event loop first, so listProviders
  // itself answers from cache instead of freezing the app for seconds.
  ipcMain.handle('providers:list', async () => {
    await warmProviderCache()
    return listProviders()
  })

  // Skills
  ipcMain.handle('skills:list', () => listSkills(getSettings().defaultCwd))
  ipcMain.handle('skills:create', (_e, name: string, description: string) =>
    createSkill(name, description)
  )

  // Settings + Claude accounts
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:update', (_e, patch: Partial<AppSettings>) => {
    const next = updateSettings(patch)
    setRuntimePrefs(next.runtimePrefs)
    if (typeof patch?.agentBridge === 'boolean') syncAgentBridge()
    if (typeof patch?.lanEnabled === 'boolean') syncLan()
    if (typeof patch?.lanDeviceName === 'string') sendLanState()
    return next
  })
  // Read back from the OS every time rather than caching: the user can turn
  // this off in Windows Settings or Task Manager without telling us.
  ipcMain.handle('settings:getLaunchAtLogin', () => getLaunchAtLogin())
  ipcMain.handle('settings:setLaunchAtLogin', (_e, enabled: boolean) => setLaunchAtLogin(enabled))
  // `provider` comes from the renderer: anything that isn't a CLI with
  // account support falls back to Claude, the original (and only) meaning.
  ipcMain.handle('accounts:add', (_e, label: string, provider?: unknown) =>
    addAccount(String(label ?? ''), isAccountProvider(provider) ? provider : 'claude')
  )
  ipcMain.handle('accounts:rename', (_e, id: string, label: string) => renameAccount(id, label))
  ipcMain.handle('accounts:remove', (_e, id: string) => removeAccount(id))
  ipcMain.handle('accounts:setCurrent', (_e, id: string | null, provider?: unknown) =>
    setCurrentAccount(typeof id === 'string' ? id : null, isAccountProvider(provider) ? provider : 'claude')
  )

  // App housekeeping: where our files are, and a way to get at the log.
  ipcMain.handle(
    'app:paths',
    (): AppPaths => ({
      userData: app.getPath('userData'),
      logsDir: logDir(),
      logFile: logFile(),
      version: app.getVersion()
    })
  )

  // GitHub Releases updates (see updater.ts). The install call never returns
  // normally on success: the app quits and the installer relaunches it.
  ipcMain.handle('update:check', () => runUpdateCheck())
  ipcMain.handle('update:install', async () => {
    const result = await runUpdateCheck()
    if (!result.latestVersion) throw new Error(result.error ?? '目前已是最新版本')
    // `quitting` is only set once the download is verified and the installer
    // is running — a download can take minutes, and closing the window in
    // that time must still hide to tray rather than quit. installUpdate
    // rejects (leaving it false) on any failure before the hand-off.
    await installUpdate(result)
    quitting = true
  })
  ipcMain.handle('update:openReleasePage', () => shell.openExternal(RELEASES_PAGE))
  ipcMain.handle('app:openPath', (_e, target: 'userData' | 'logs') =>
    shell.openPath(target === 'logs' ? logDir() : app.getPath('userData'))
  )
  // The renderer's own failures (ErrorBoundary, unhandled rejections) go into
  // the same log as main's, so one file tells the whole story.
  ipcMain.on('app:log', (_e, level: unknown, message: unknown) => {
    const text = String(message ?? '').slice(0, 4000)
    if (level === 'error') log.error(`[renderer] ${text}`)
    else if (level === 'warn') log.warn(`[renderer] ${text}`)
    else log.info(`[renderer] ${text}`)
  })
  ipcMain.on('app:notifyAttention', (_e, sessionId: unknown, title: unknown, body: unknown) =>
    notifyAttention(String(sessionId ?? ''), String(title ?? 'baguette').slice(0, 100), String(body ?? '').slice(0, 200))
  )

  // Hook 庫 (managed hooks mirrored into ~/.claude/settings.json). Input is
  // validated inside hooks.ts (sanitizeHookPatch).
  ipcMain.handle('hooks:list', () => listHooks())
  ipcMain.handle('hooks:create', (_e, input: Omit<HookDef, 'id'>) => createHook(input))
  ipcMain.handle('hooks:update', (_e, id: string, patch: Partial<Omit<HookDef, 'id'>>) =>
    updateHook(String(id), patch)
  )
  ipcMain.handle('hooks:remove', (_e, id: string) => removeHook(String(id)))
  ipcMain.handle('hooks:setEnabled', (_e, id: string, enabled: boolean) =>
    setHookEnabled(String(id), enabled === true)
  )

  // 內網裝置 (lan.ts). lanNode exists from startup on (syncLan), running or not.
  const lan = (): LanNode => {
    if (!lanNode) throw new Error('內網連線尚未初始化')
    return lanNode
  }
  ipcMain.handle('lan:state', () => lanState(lan()))
  ipcMain.handle('lan:setSync', (_e, id: unknown, cat: unknown, on: unknown) => {
    const c = SYNC_CATEGORIES.find((x) => x === cat)
    if (!c || !lanSync) throw new Error('不允許的操作')
    return lanSync.setEnabled(String(id ?? ''), c, on === true)
  })
  ipcMain.handle('lan:syncNow', (_e, id: unknown) => {
    if (!lanSync) throw new Error('內網連線尚未初始化')
    return lanSync.syncNow(String(id ?? ''))
  })
  ipcMain.handle('lan:startPairing', () => lan().startPairing())
  ipcMain.handle('lan:cancelPairing', () => lan().cancelPairing())
  ipcMain.handle('lan:pair', (_e, target: unknown, code: unknown) => {
    const t = (target && typeof target === 'object' ? target : {}) as Record<string, unknown>
    return lan().pair(
      {
        deviceId: typeof t.deviceId === 'string' ? t.deviceId : undefined,
        address: typeof t.address === 'string' ? t.address : undefined
      },
      String(code ?? '')
    )
  })
  ipcMain.handle('lan:probe', (_e, address: unknown) => lan().probe(String(address ?? '')))
  ipcMain.handle('lan:unpair', (_e, id: unknown) => lan().unpair(String(id ?? '')))
  ipcMain.handle('lan:setAllowWrite', (_e, id: unknown, allow: unknown) =>
    lan().setAllowWrite(String(id ?? ''), allow === true)
  )
  ipcMain.handle('lan:setAllowShell', (_e, id: unknown, allow: unknown) =>
    lan().setAllowShell(String(id ?? ''), allow === true)
  )
  ipcMain.handle('lan:call', (_e, deviceId: unknown, call: unknown) => {
    const c = sanitizeLanCall(call)
    if (!c) throw new Error('不允許的操作')
    return lan().call(String(deviceId ?? ''), c)
  })
  // For the MCP section: how an AI CLI launches mcp.ts with this very exe.
  ipcMain.handle('lan:mcpInfo', () => ({
    exe: process.execPath,
    script: mcpScriptPath(),
    bridgeFile: bridgeInfoFile(),
    bridgeOn: getSettings().agentBridge
  }))

  // 知識庫 — 'note' (freeform lessons/SOPs) and 'db' (SQLite registry entries)
  // share one file and one panel, split by a tab in the UI.
  type KnowledgeFields = Partial<
    Pick<KnowledgeEntry, 'kind' | 'title' | 'content' | 'dbFile' | 'dbPath' | 'tags'>
  >
  ipcMain.handle('knowledge:list', () => listKnowledge())
  ipcMain.handle('knowledge:add', (_e, fields: KnowledgeFields) => addKnowledge(fields ?? {}))
  ipcMain.handle('knowledge:update', (_e, id: string, patch: KnowledgeFields) =>
    updateKnowledge(id, patch)
  )
  ipcMain.handle('knowledge:remove', (_e, id: string) => removeKnowledge(id))
  ipcMain.handle('knowledge:path', () => knowledgePath())

  // Clipboard (used for reliable paste/copy in the pty terminal — see TerminalView).
  ipcMain.handle('clipboard:readText', () => clipboard.readText())
  ipcMain.handle('clipboard:writeText', (_e, text: unknown) => clipboard.writeText(String(text ?? '')))

  /**
   * Spill a clipboard image to a temp PNG and return its path, or null when
   * the clipboard holds no image.
   *
   * A pty carries bytes, not images, so "paste a screenshot" can only mean
   * handing the CLI a file it can open — which is exactly what Claude Code
   * does with an image path. Files land in the OS temp dir and are left for
   * the OS to reclaim; the CLI may still be reading one when the tab closes.
   */
  ipcMain.handle('clipboard:readImageAsFile', () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const file = join(app.getPath('temp'), `baguette-paste-${Date.now()}.png`)
    try {
      writeFileSync(file, image.toPNG())
      return file
    } catch {
      return null
    }
  })

  // Native folder picker (used by the settings default-path field).
  ipcMain.handle('dialog:pickDirectory', async () => {
    const opts: Electron.OpenDialogOptions = {
      title: '選擇資料夾',
      properties: ['openDirectory']
    }
    const res = mainWindow
      ? await dialog.showOpenDialog(mainWindow, opts)
      : await dialog.showOpenDialog(opts)
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  // Sessions
  ipcMain.handle('session:create', async (_e, opts: CreateSessionOptions) => {
    // ptyManager.create resolves the CLI synchronously; make sure the WSL
    // probe has an answer first (a cache hit once warm), so a cold WSL can't
    // turn into "找不到 claude" through the short synchronous fallback.
    await warmProviderCache()
    // Everything here arrives from the renderer, so rebuild the options from
    // known-good fields rather than spreading them. `command`/`commandArgs`
    // are filled in here from the resolved provider, never taken from the
    // renderer's input — accepting them there would turn any renderer-side
    // compromise into arbitrary process execution.
    const provider = sanitizeProvider(opts?.provider)
    if (!provider) throw new Error(`未知的 provider：${String(opts?.provider)}`)

    const settings = getSettings()
    const enriched: CreateSessionOptions = {
      provider,
      cwd: typeof opts?.cwd === 'string' && opts.cwd ? opts.cwd : settings.defaultCwd,
      accountId: typeof opts?.accountId === 'string' ? opts.accountId : undefined,
      autoOpenLoginUrl: opts?.autoOpenLoginUrl === true,
      launch: sanitizeLaunch(opts?.launch),
      readOnly: opts?.readOnly === true,
      // From settings only: the renderer can't ask for it per tab.
      autoApprove: opts?.readOnly !== true && settings.autoApprove?.[provider] === true,
      cols: typeof opts?.cols === 'number' ? opts.cols : undefined,
      rows: typeof opts?.rows === 'number' ? opts.rows : undefined
    }
    if (provider === 'claude') {
      enriched.claudeConfigDir = resolveClaudeConfigDir(enriched.accountId ?? settings.currentAccountId)
    } else if (isAccountProvider(provider)) {
      // 'default' explicitly asks for the CLI's own default dir (the accounts
      // screen's 登入 on that row). Any other id that isn't this CLI's (e.g.
      // the selected group's Claude account) resolves to undefined, so fall
      // back to this CLI's current account.
      const dir =
        enriched.accountId === 'default'
          ? undefined
          : (resolveAccountDir(provider, enriched.accountId) ??
            resolveAccountDir(provider, currentAccountFor(provider)))
      enriched.accountDir = dir
      // Record which account the tab really runs under, so a restore reuses it.
      enriched.accountId = dir
        ? settings.accounts.find((a) => a.provider === provider && a.configDir === dir)?.id
        : undefined
    }
    const info = ptyManager.create(enriched)
    if (info.status === 'error') log.warn(`session ${info.id} (${provider}) failed to start: ${info.message}`)
    return info
  })
  ipcMain.handle('session:list', () => ptyManager.list())
  // Called once per terminal when it mounts; returns the output produced
  // before it could subscribe (the startup banner, an early prompt) and starts
  // live streaming for that session.
  ipcMain.handle('session:attach', (_e, id: string) => ptyManager.attach(id))
  ipcMain.on('session:write', (_e, id: string, data: string) => ptyManager.write(id, data))
  ipcMain.on('session:resize', (_e, id: string, cols: number, rows: number) =>
    ptyManager.resize(id, cols, rows)
  )
  ipcMain.on('bridge:ready', () => markBridgeReady())
  ipcMain.on('session:kill', (_e, id: string) => {
    ptyManager.kill(id)
    agentBridge?.forget(id)
  })
  // Re-spawn in place (same tab, resumed conversation) — the manual twin of
  // the automatic restart after another tab's login.
  ipcMain.handle('session:restart', async (_e, id: string) => {
    await warmProviderCache()
    return ptyManager.restart(String(id))
  })

  // Open-tab snapshot (persisted across app restarts; see session-store.ts).
  ipcMain.handle('sessions:getSnapshot', () => getSnapshot())
  ipcMain.handle('sessions:saveSnapshot', (_e, snap: SessionSnapshot) => saveSnapshot(snap))
}

// Only one copy may run at a time. Every instance shares one userData
// directory (settings.json, hooks.json, sessions.json) AND reconciles hooks
// into the same ~/.claude/settings.json, so a second instance silently fights
// the first: last writer wins, and the tab snapshot of whichever quits last
// overwrites the other. That is easy to hit now that the app is installed —
// double-clicking the shortcut twice, or running `npm run dev` while the
// installed build is open.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // Someone tried to launch a second copy: surface the window we already have
  // (it may be hidden in the tray) instead of doing nothing, which would look
  // like the app failed to start.
  app.on('second-instance', () => showMainWindow())

  // Windows groups taskbar buttons and attributes toast notifications by this
  // id; the NSIS installer registers the same one for the shortcut.
  app.setAppUserModelId('com.ethanlin.baguette')

  app.whenReady().then(() => {
    log.info(`baguette ${app.getVersion()} starting (electron ${process.versions.electron})`)
    // Start the (cold, multi-second) WSL probes now, while the window loads,
    // rather than when the renderer first asks.
    setRuntimePrefs(getSettings().runtimePrefs)
    void warmProviderCache()
    registerIpc()
    wirePtyEvents()
    syncAgentBridge()
    syncLan()
    // A Claude session edits knowledge.json directly (see the
    // knowledge-capture skill), so the panel follows the file rather than
    // only its own writes.
    watchKnowledge(() => sendToRenderer(mainWindow, 'knowledge:changed', listKnowledge()))
    tray = createTray({
      onShow: showMainWindow,
      onQuit: () => {
        quitting = true
        app.quit()
      }
    })
    if (!tray) log.warn('tray unavailable; close-to-tray disabled for this run')
    createWindow()
    scheduleUpdateChecks()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('child-process-gone', (_e, details) => {
    log.error(`child process gone: ${details.type} ${details.reason} (exit ${details.exitCode})`)
  })
}

app.on('window-all-closed', () => {
  ptyManager.killAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  quitting = true
  agentBridge?.stop()
  lanNode?.stop()
  ptyManager.killAll()
  log.info('quitting')
})
