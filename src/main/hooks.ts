import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import type { HookDef, HookEvent, HookSchedule } from '../shared/types'
import { HOOK_EVENTS, HOOK_MATCHER_EVENTS } from '../shared/types'
import { writeFileAtomic } from './atomic-write'

/**
 * Thrown when ~/.claude/settings.json exists but cannot be understood. The
 * caller turns this into a message for the user; it must never be swallowed
 * into "treat the file as empty", because that path rewrites the file.
 */
export class ClaudeSettingsUnreadableError extends Error {
  constructor(reason: string) {
    super(
      `無法讀取 ~/.claude/settings.json（${reason}）。` +
        '為避免覆蓋你既有的 Claude 設定，這次沒有寫入任何內容；' +
        '請先修正該檔案的格式後再試一次。'
    )
    this.name = 'ClaudeSettingsUnreadableError'
  }
}

// The Hook 庫 keeps its own managed list in userData/hooks.json. Enabled hooks
// are mirrored into ~/.claude/settings.json so Claude Code actually runs them.
// We only ever touch hook entries whose command we manage, so the user's manual
// hooks and every other settings key are preserved untouched.
//
// The pseudo-event 'Schedule' is different: Claude Code hooks only fire on
// tool-use/session events, there is no time-based trigger. Those are instead
// backed by a Windows Scheduled Task per hook (see reconcileSchedules), so
// they fire at wall-clock time regardless of whether this app or Claude Code
// is even running — the same guarantee the WSL crontab this replaces gave us.

interface HookStore {
  hooks: HookDef[]
  /** Commands last written into ~/.claude/settings.json, so we can prune them. */
  applied: string[]
  /** Scheduled-task names last created, so we can prune ones no longer wanted. */
  appliedSchedules: string[]
}

function storePath(): string {
  return join(app.getPath('userData'), 'hooks.json')
}

function claudeSettingsPath(): string {
  return join(os.homedir(), '.claude', 'settings.json')
}

let cache: HookStore | null = null

function load(): HookStore {
  if (cache) return cache
  try {
    const raw = readFileSync(storePath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<HookStore>
    cache = {
      hooks: Array.isArray(parsed.hooks) ? parsed.hooks : [],
      applied: Array.isArray(parsed.applied) ? parsed.applied : [],
      appliedSchedules: Array.isArray(parsed.appliedSchedules) ? parsed.appliedSchedules : []
    }
  } catch {
    cache = { hooks: [], applied: [], appliedSchedules: [] }
  }
  return cache
}

function persist(next: HookStore): HookStore {
  cache = next
  try {
    writeFileAtomic(storePath(), JSON.stringify(next, null, 2))
  } catch {
    /* best-effort */
  }
  return next
}

// ---- Renderer input validation -----------------------------------------------
//
// Everything below arrives over IPC. A hook's command ends up in the user's
// ~/.claude/settings.json and, for 'Schedule', in a .bat that Task Scheduler
// runs — so the shape is checked field by field here rather than spread in.

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

function sanitizeSchedule(raw: unknown): HookSchedule | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const s = raw as Partial<HookSchedule>
  if (typeof s.time !== 'string' || !TIME_RE.test(s.time)) return undefined
  const days = Array.isArray(s.days)
    ? [...new Set(s.days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))]
    : []
  return { time: s.time, days }
}

function isHookEvent(value: unknown): value is HookDef['event'] {
  return value === 'Schedule' || HOOK_EVENTS.includes(value as HookEvent)
}

/**
 * Validate a partial hook coming from the renderer. Unknown keys are dropped,
 * wrongly-typed fields are ignored, and an unknown event throws — silently
 * falling back to some default event would sync a hook the user never asked
 * for into their Claude settings.
 */
export function sanitizeHookPatch(raw: unknown): Partial<Omit<HookDef, 'id'>> {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  const out: Partial<Omit<HookDef, 'id'>> = {}
  if (typeof r.name === 'string') out.name = r.name
  if ('event' in r) {
    if (!isHookEvent(r.event)) throw new Error(`未知的 hook 事件：${String(r.event)}`)
    out.event = r.event
  }
  if (typeof r.matcher === 'string') out.matcher = r.matcher
  if (typeof r.command === 'string') out.command = r.command
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled
  if ('schedule' in r) out.schedule = sanitizeSchedule(r.schedule)
  return out
}

// ---- Claude settings.json sync ------------------------------------------------

type CommandHook = { type: 'command'; command: string }
type HookGroup = { matcher?: string; hooks: CommandHook[] }
type HooksMap = Record<string, HookGroup[]>

/**
 * Read ~/.claude/settings.json, keeping "there is no file yet" strictly
 * separate from "there is a file and we could not understand it".
 *
 * Conflating the two is destructive: this module rewrites the file, so
 * treating an unreadable file as `{}` silently deletes every setting the user
 * has (model, permissions, mcpServers, their own hooks). Both failure shapes
 * are ordinary — Notepad writes a UTF-8 BOM, hand-edited JSON grows trailing
 * commas, and Claude Code itself rewrites this file so a read can land
 * mid-write.
 */
function readClaudeSettings(): Record<string, unknown> {
  let raw: string
  try {
    raw = readFileSync(claudeSettingsPath(), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new ClaudeSettingsUnreadableError((err as Error).message)
  }

  // A UTF-8 BOM is invisible in an editor but makes JSON.parse throw.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  if (raw.trim() === '') return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new ClaudeSettingsUnreadableError((err as Error).message)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ClaudeSettingsUnreadableError('內容不是一個 JSON 物件')
  }
  return parsed as Record<string, unknown>
}

/** Only back up once per app run, so we never overwrite a good backup with a bad one. */
let backedUpThisRun = false

/** Keep a one-off copy of the user's settings before the first rewrite of this run. */
function backupClaudeSettingsOnce(): void {
  if (backedUpThisRun) return
  backedUpThisRun = true
  const path = claudeSettingsPath()
  if (!existsSync(path)) return
  try {
    copyFileSync(path, `${path}.dashboard-bak`)
  } catch {
    /* best-effort: a missing backup must not block the sync */
  }
}

/**
 * Rewrite ~/.claude/settings.json so its `hooks` reflect our enabled managed
 * hooks. Prunes any group entry whose command we manage (current defs + the
 * previously-applied set), then appends the enabled ones. Everything else in
 * the file is left exactly as-is.
 *
 * Throws ClaudeSettingsUnreadableError rather than writing when the existing
 * file cannot be parsed — see readClaudeSettings.
 */
function syncToClaude(store: HookStore): string[] {
  const eventHooks = store.hooks.filter(
    (h): h is HookDef & { event: HookEvent } => h.event !== 'Schedule'
  )
  const managed = new Set<string>([...store.applied, ...eventHooks.map((h) => h.command)])

  const settings = readClaudeSettings()

  const hooksMap: HooksMap = { ...((settings.hooks as HooksMap) ?? {}) }

  // 1) Drop everything we manage from every event bucket.
  for (const event of Object.keys(hooksMap)) {
    const groups = (hooksMap[event] ?? [])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !managed.has(h.command)) }))
      .filter((g) => g.hooks.length > 0)
    if (groups.length > 0) hooksMap[event] = groups
    else delete hooksMap[event]
  }

  // 2) Append our currently-enabled hooks ('Schedule' hooks are handled
  // separately by reconcileSchedules — they have no Claude Code event).
  const nowApplied: string[] = []
  for (const h of eventHooks) {
    if (!h.enabled || !h.command.trim()) continue
    const group: HookGroup = { hooks: [{ type: 'command', command: h.command }] }
    if (HOOK_MATCHER_EVENTS.includes(h.event)) group.matcher = h.matcher.trim() || '*'
    hooksMap[h.event] = [...(hooksMap[h.event] ?? []), group]
    nowApplied.push(h.command)
  }

  // 3) Write back, preserving all other keys.
  const next = { ...settings }
  if (Object.keys(hooksMap).length > 0) next.hooks = hooksMap
  else delete next.hooks
  try {
    mkdirSync(join(os.homedir(), '.claude'), { recursive: true })
    backupClaudeSettingsOnce()
    writeFileAtomic(claudeSettingsPath(), JSON.stringify(next, null, 2))
  } catch {
    /* best-effort; managed store still records intent */
  }
  return nowApplied
}

// ---- Schedule sync (Windows Task Scheduler) -----------------------------------

const DAY_CODES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

function schedulesDir(): string {
  const dir = join(app.getPath('userData'), 'schedules')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* ignore */
  }
  return dir
}

function scheduleTaskName(hookId: string): string {
  return `DashBoard_Hook_${hookId}`
}

/** Best-effort schtasks invocation; scheduling is Windows-only and non-critical. */
function runSchtasks(args: string[]): void {
  if (process.platform !== 'win32') return
  try {
    execFileSync('schtasks', args, { windowsHide: true, stdio: 'ignore' })
  } catch {
    /* e.g. no permission, task already gone — the managed store is still authoritative */
  }
}

/**
 * Reconcile 'Schedule' hooks against Windows Task Scheduler: one task per
 * enabled schedule hook, named so we can find & prune our own tasks later
 * without touching anything the user (or another tool) created directly. The
 * task runs a small generated .bat wrapping the hook's command, which sidesteps
 * all quoting issues `schtasks /tr` has with raw multi-word command lines.
 */
function reconcileSchedules(store: HookStore): string[] {
  const desired = store.hooks.filter(
    (h) => h.event === 'Schedule' && h.enabled && h.command.trim() && h.schedule
  )
  const desiredNames = new Set(desired.map((h) => scheduleTaskName(h.id)))

  for (const name of store.appliedSchedules) {
    if (desiredNames.has(name)) continue
    runSchtasks(['/delete', '/tn', name, '/f'])
    // Also drop the generated wrapper. Leaving it behind means a command the
    // user believes they deleted stays readable on disk indefinitely.
    const hookId = name.replace(/^DashBoard_Hook_/, '')
    try {
      rmSync(join(schedulesDir(), `${hookId}.bat`), { force: true })
    } catch {
      /* already gone */
    }
  }

  const nowApplied: string[] = []
  for (const h of desired) {
    const schedule = h.schedule as HookSchedule
    const name = scheduleTaskName(h.id)
    const batPath = join(schedulesDir(), `${h.id}.bat`)
    try {
      writeFileSync(batPath, `@echo off\r\n${h.command}\r\n`, 'utf8')
    } catch {
      continue
    }
    const days = schedule.days.length > 0 && schedule.days.length < 7 ? schedule.days : [0, 1, 2, 3, 4, 5, 6]
    const sc = days.length === 7 ? 'DAILY' : 'WEEKLY'
    const args = ['/create', '/tn', name, '/tr', batPath, '/sc', sc, '/st', schedule.time, '/f']
    if (sc === 'WEEKLY') args.push('/d', days.map((d) => DAY_CODES[d] ?? 'MON').join(','))
    runSchtasks(args)
    nowApplied.push(name)
  }
  return nowApplied
}

/** Apply the current managed store to Claude settings + Task Scheduler, and remember what we wrote. */
function reconcile(store: HookStore): HookStore {
  // Record intent BEFORE touching anything outside our own store. Pruning
  // relies on `applied` ∪ current commands to recognize what we own, so if we
  // die between the two writes, having already saved the new hooks means the
  // next reconcile still recognizes (and can prune) whatever we managed to
  // write. Syncing first and dying would strand an entry in the user's
  // settings.json that we no longer know about and can never remove.
  persist(store)
  const applied = syncToClaude(store)
  const appliedSchedules = reconcileSchedules(store)
  return persist({ ...store, applied, appliedSchedules })
}

// ---- Public API ---------------------------------------------------------------

export function listHooks(): HookDef[] {
  return load().hooks
}

export function createHook(rawInput: Omit<HookDef, 'id'>): HookDef[] {
  const input = sanitizeHookPatch(rawInput)
  if (!input.event) throw new Error('hook 需要指定事件')
  const s = load()
  const hook: HookDef = {
    // Random suffix, not `hooks.length`: length repeats after a delete, so two
    // hooks created in the same millisecond around a removal could collide —
    // and a collision makes edit/remove hit both, and their scheduled task and
    // .bat file overwrite each other.
    id: `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    name: (input.name ?? '').trim() || '未命名 hook',
    event: input.event,
    matcher: input.matcher ?? '',
    command: input.command ?? '',
    enabled: input.enabled ?? false,
    schedule: input.schedule
  }
  return reconcile({ ...s, hooks: [...s.hooks, hook] }).hooks
}

export function updateHook(id: string, rawPatch: Partial<Omit<HookDef, 'id'>>): HookDef[] {
  const patch = sanitizeHookPatch(rawPatch)
  const s = load()
  const hooks = s.hooks.map((h) => (h.id === id ? { ...h, ...patch } : h))
  return reconcile({ ...s, hooks }).hooks
}

export function removeHook(id: string): HookDef[] {
  const s = load()
  const hooks = s.hooks.filter((h) => h.id !== id)
  return reconcile({ ...s, hooks }).hooks
}

export function setHookEnabled(id: string, enabled: boolean): HookDef[] {
  return updateHook(id, { enabled })
}

export type { HookEvent }
