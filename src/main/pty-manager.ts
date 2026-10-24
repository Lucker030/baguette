import { EventEmitter } from 'node:events'
import os from 'node:os'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { shell } from 'electron'
import type { CreateSessionOptions, SessionInfo, SessionLaunch } from '../shared/types'
import { ACCOUNT_DIR_ENV, isAccountProvider } from '../shared/types'
import { ActivityTracker } from './activity'
import { AUTH_TAIL_KEEP, classifyAuthOutput, watchCredentials } from './auth-watch'
import {
  resolveClaudeLaunch,
  resolveLaunch,
  claudeCredentialsPath,
  claudeProjectDirectory
} from './providers'

/**
 * A tab typed into this recently is the one the user is signing in from, not
 * one left stuck — see onCredentialsChanged.
 */
const RECENT_INPUT_MS = 60_000

// Bound how much freshly-spawned output we scan for a login URL: enough to
// cover a CLI banner + login prompt, small enough to never matter for memory.
const LOGIN_URL_SCAN_LIMIT = 8000
const LOGIN_URL_RE = /https?:\/\/[^\s"'<>]*(?:claude\.ai|anthropic\.com)[^\s"'<>]*/i

/** Strip ANSI CSI/OSC escape sequences so a URL isn't split by color codes. */
function stripAnsi(data: string): string {
  // Matching escape sequences necessarily means matching control characters.
  /* eslint-disable no-control-regex */
  return data
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  /* eslint-enable no-control-regex */
}

// node-pty is a native module shipped as a prebuilt binary. Load it lazily so a
// missing/incompatible binary degrades gracefully instead of crashing the app.
type IPty = {
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  pid: number
}
type PtyModule = {
  spawn(file: string, args: string[], opts: Record<string, unknown>): IPty
}

let ptyMod: PtyModule | null = null
let ptyLoadError: string | null = null

/**
 * Translate a desired launch mode into the extra CLI args to append.
 *
 * NOTE on Claude ids: we deliberately do NOT inject `--session-id <uuid>` on new
 * sessions. On this machine Claude runs via WSL, and there `--session-id` is not
 * honored — Claude keeps its own generated id, so an id WE invented up front
 * never corresponds to a real conversation. Instead, once a session's real id
 * has been discovered after the fact (see discoverClaudeSessionId below, which
 * reads it back from Claude's own transcript file), `resume` uses that real id
 * with `--resume <id>` — verified empirically to work fine, since it's a
 * genuine id Claude itself chose, not a fabricated one. Only when no real id
 * was ever captured for this tab (e.g. it closed before discovery finished)
 * does resume fall back to `--continue` (most-recent conversation for that
 * cwd+account) — which is also what multiple tabs sharing one cwd still
 * collide on if none of them have a captured id yet. Only claude/codex honor
 * resume; other providers get no extra args.
 */
function launchArgs(
  provider: CreateSessionOptions['provider'],
  launch: SessionLaunch
): { extraArgs: string[]; claudeSessionId?: string } {
  if (provider === 'claude') {
    switch (launch.kind) {
      case 'new':
        return { extraArgs: [] }
      case 'continue':
        return { extraArgs: ['--continue'] }
      case 'pick':
        return { extraArgs: ['--resume'] }
      case 'resume':
        return launch.sessionId
          ? { extraArgs: ['--resume', launch.sessionId], claudeSessionId: launch.sessionId }
          : { extraArgs: ['--continue'] }
    }
  }
  if (provider === 'codex') {
    switch (launch.kind) {
      case 'new':
        return { extraArgs: [] }
      case 'continue':
        return { extraArgs: ['resume', '--last'] }
      case 'pick':
        return { extraArgs: ['resume'] }
      case 'resume':
        return { extraArgs: ['resume', launch.sessionId] }
    }
  }
  if (provider === 'antigravity') {
    // agy has --continue and --conversation <id>, but no picker flag and no
    // way for us to learn a tab's conversation id, so every resumable kind
    // means "continue the most recent conversation".
    return { extraArgs: launch.kind === 'new' ? [] : ['--continue'] }
  }
  return { extraArgs: [] }
}

/**
 * Flags that start a CLI without the ability to change anything: Claude Code's
 * plan mode, Codex's read-only sandbox, agy's plan mode. Used for tabs another
 * agent opens through the agent bridge (agent-bridge.ts), so a conversation
 * the user is only watching can't edit files or run commands behind their back.
 * They go BEFORE the launch args: `codex resume <id>` is a subcommand, and its
 * global flags have to precede it.
 *
 * Read-only alone is not enough: each CLI can ASK to step outside it (Codex:
 * "run this outside the sandbox?", Claude: leave plan mode), and the default
 * answer is yes — so the bridge's own Enter, sent with every message, would
 * approve it (verified with Codex). So the escape hatches are shut too: Codex
 * never asks, Claude doesn't get the tools that write or leave plan mode. agy
 * has no "never ask" switch; its terminal sandbox is the most it offers.
 * `--disallowedTools=` keeps Claude's variadic flag from eating what follows.
 */
function readOnlyArgs(provider: CreateSessionOptions['provider']): string[] {
  switch (provider) {
    case 'claude':
      return ['--permission-mode', 'plan', '--disallowedTools=Bash,Edit,Write,NotebookEdit,ExitPlanMode']
    case 'codex':
      return ['--sandbox', 'read-only', '--ask-for-approval', 'never']
    case 'antigravity':
      return ['--mode', 'plan', '--sandbox']
    default:
      return []
  }
}

/** Providers that get a startup banner, and the label it's shown under. */
const BANNER_LABELS: Partial<Record<CreateSessionOptions['provider'], string>> = {
  claude: 'Claude',
  codex: 'Codex',
  copilot: 'Copilot',
  antigravity: 'Antigravity（agy）',
  shell: 'Shell'
}

/** Short human label for the launch mode, shown in the startup banner. */
function launchLabel(launch: SessionLaunch): string {
  switch (launch.kind) {
    case 'continue':
      return ' · 續聊最近對話'
    case 'pick':
      return ' · 選擇存檔'
    case 'resume':
      return ' · 還原對話'
    default:
      return ''
  }
}

function loadPty(): void {
  if (ptyMod || ptyLoadError) return
  try {
    const require = createRequire(import.meta.url)
    ptyMod = require('@homebridge/node-pty-prebuilt-multiarch') as PtyModule
  } catch (e) {
    ptyLoadError = (e as Error).message
  }
}

/**
 * How much early output to hold for a terminal that hasn't attached yet.
 * Generous enough for a CLI banner plus a first screen, bounded so a chatty
 * process can't grow it without limit.
 */
const BACKLOG_LIMIT = 256 * 1024

interface Session {
  info: SessionInfo
  pty: IPty | null
  /** Login flow only: buffered recent output + whether a URL was already found. */
  loginUrlBuffer: string
  loginUrlDone: boolean
  /**
   * Output produced before (and after) the renderer's TerminalView attached.
   * The renderer cannot subscribe until it has mounted, which is necessarily
   * after `create()` returns — so anything emitted in between, including our
   * own startup banner, would otherwise be lost outright.
   */
  backlog: string
  /** Set by attach(); until then output is buffered rather than emitted. */
  attached: boolean
  /** Cancels discoverClaudeSessionId's poll loop if the pty exits before it finds anything. */
  cancelDiscovery?: () => void
  /** Last size handed to the pty, so an unchanged resize can be dropped (see resize()). */
  lastSize?: { cols: number; rows: number }
  /** Busy/idle detection for the sidebar and notifications — see activity.ts. */
  activity?: ActivityTracker
  /** What create() was asked for, kept so restart() can relaunch the same way. */
  opts: CreateSessionOptions
  /** The launch mode of the current process (restart derives the next one from it). */
  launch: SessionLaunch
  /** Rolling tail of stripped output for auth-state classification (claude only). */
  authTail: string
  /** When the CLI last printed that it needs a sign-in. */
  authFlaggedAt?: number
  /** Last time the user typed into this tab — see onCredentialsChanged. */
  lastInputAt?: number
}

export class PtyManager extends EventEmitter {
  private sessions = new Map<string, Session>()
  private counter = 0
  /**
   * Transcript filenames already attributed to some session by
   * discoverClaudeSessionId, across every tab in every cwd. Without this, two
   * tabs sharing one cwd each running their own independent poll loop would
   * both see the OTHER one's newly-changed file as "the one unclaimed change"
   * and both claim it — this makes "already spoken for" a fact every poll can
   * check, not something each tab could only know about its own activity.
   */
  private claimedTranscriptFiles = new Set<string>()
  /** Account key (CLAUDE_CONFIG_DIR or '') -> stop function for its credentials watcher. */
  private credentialWatchers = new Map<string, () => void>()

  create(opts: CreateSessionOptions): SessionInfo {
    const id = `s${++this.counter}-${Date.now().toString(36)}`
    const cwd = opts.cwd || os.homedir()
    const launch = opts.launch ?? { kind: 'new' }
    const session: Session = {
      info: { id, provider: opts.provider, cwd, status: 'starting', ...(opts.readOnly ? { readOnly: true } : {}) },
      pty: null,
      loginUrlBuffer: '',
      loginUrlDone: !opts.autoOpenLoginUrl,
      backlog: '',
      attached: false,
      opts: { ...opts, cwd },
      launch,
      authTail: ''
    }
    this.sessions.set(id, session)
    this.launch(session, launch, { cols: opts.cols, rows: opts.rows })
    // A failed launch is reported the same way a later exit is. Buffered
    // (via the backlog) rather than emitted immediately: the renderer has not
    // mounted a terminal for this id yet, so an emit now goes nowhere.
    if (session.info.status === 'error') queueMicrotask(() => this.emit('status', session.info))
    if (opts.provider === 'claude') void this.ensureCredentialsWatch(opts.claudeConfigDir)
    return session.info
  }

  /**
   * Spawn (or re-spawn) a session's process. Shared by create() and
   * restart(): everything about how a tab launches — provider resolution, the
   * WSL fallback, env, banner, session-id discovery, activity and auth
   * detection — lives here once, so a restarted tab behaves exactly like a
   * fresh one apart from which conversation it opens on.
   */
  private launch(
    session: Session,
    launch: SessionLaunch,
    size: { cols?: number; rows?: number }
  ): void {
    const { opts, info } = session
    const { id, cwd } = info
    const { extraArgs: resumeArgs, claudeSessionId } = launchArgs(opts.provider, launch)
    const extraArgs = opts.readOnly ? [...readOnlyArgs(opts.provider), ...resumeArgs] : resumeArgs
    if (claudeSessionId) info.claudeSessionId = claudeSessionId
    session.launch = launch

    const fail = (message: string): void => {
      info.status = 'error'
      info.message = message
      session.loginUrlDone = true
      session.backlog = `${session.backlog}\r\n\x1b[31m${message}\x1b[0m\r\n`.slice(-BACKLOG_LIMIT)
    }

    // Non-Claude account: the CLI's own config-dir variable (CODEX_HOME,
    // COPILOT_HOME) pointed at that account's folder. Claude's goes through
    // claudeConfigDir, which several Claude-only features also key off.
    const accountEnv =
      opts.accountDir && opts.provider !== 'claude' && isAccountProvider(opts.provider)
        ? { name: ACCOUNT_DIR_ENV[opts.provider], dir: opts.accountDir }
        : undefined

    const resolved = opts.command
      ? { command: opts.command, args: opts.commandArgs ?? [] }
      : opts.provider === 'claude'
        ? resolveClaudeLaunch(cwd, opts.claudeConfigDir, extraArgs)
        : resolveLaunch(opts.provider, cwd, extraArgs, accountEnv)
    if (!resolved) {
      fail(`找不到「${opts.provider}」對應的執行檔，請先安裝或加入 PATH。`)
      return
    }

    loadPty()
    if (!ptyMod) {
      fail(`無法載入終端機原生模組 (node-pty)：${ptyLoadError ?? 'unknown'}`)
      return
    }

    // Per-account Claude config lives in an isolated CLAUDE_CONFIG_DIR so
    // multiple Claude logins can coexist; omitted → the built-in ~/.claude.
    // BAGUETTE_SESSION_ID lets anything the CLI spawns (a Claude Code hook,
    // a script) find out which tab it is running in. Nothing reads it yet.
    const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color', BAGUETTE_SESSION_ID: id }
    if (opts.provider === 'claude' && opts.claudeConfigDir) {
      env.CLAUDE_CONFIG_DIR = opts.claudeConfigDir
    }
    if (accountEnv) env[accountEnv.name] = accountEnv.dir

    // node-pty throws synchronously for an unreadable cwd or a file that isn't
    // a valid executable. Letting that escape rejects the session:create IPC,
    // which aborts the renderer's whole tab-restore loop midway and leaves it
    // stuck in `restoring` — after which no snapshot is ever saved again.
    // Report it the same way as the other two failure paths instead.
    let pty: IPty
    try {
      pty = ptyMod.spawn(resolved.command, resolved.args, {
        name: 'xterm-256color',
        cols: size.cols ?? 80,
        rows: size.rows ?? 24,
        cwd,
        env
      })
    } catch (e) {
      fail(`無法在「${cwd}」啟動「${opts.provider}」：${(e as Error).message}`)
      return
    }

    session.pty = pty
    session.lastSize = { cols: size.cols ?? 80, rows: size.rows ?? 24 }
    info.status = 'running'
    info.message = undefined
    info.authState = undefined
    session.authTail = ''

    // Make the launch mode explicit so it's never a silent surprise: a native
    // Windows binary vs the WSL (Linux) fallback behave differently for
    // credentials/accounts. Claude also shows which account dir it's bound to.
    const bannerLabel = BANNER_LABELS[opts.provider]
    if (bannerLabel) {
      const viaWsl = /[\\/]wsl(\.exe)?$/i.test(resolved.command)
      const mode = viaWsl ? 'WSL 版' : 'Windows 版'
      const acctPart =
        opts.provider === 'claude'
          ? ` · 帳號目錄：${opts.claudeConfigDir ?? '預設帳號（~/.claude）'}`
          : accountEnv
            ? ` · 帳號目錄：${accountEnv.dir}`
            : ''
      // Through pushOutput: on a first launch nothing is attached yet and the
      // line lands in the backlog; on a restart the terminal is live and
      // sees it immediately.
      this.pushOutput(
        session,
        id,
        `\x1b[2m[baguette] ${bannerLabel} 啟動方式：${mode}${acctPart}${launchLabel(launch)}\x1b[0m\r\n`
      )
    }

    // A captured real id only matters for `resume`, which already has one
    // (see launchArgs). Every other launch kind either creates a fresh
    // transcript file or bumps an existing one's mtime, so the same discovery
    // logic covers 'new', 'continue', and the interactive 'pick' alike.
    // notifyClaudeOutput is wired into onData below rather than this running
    // its own independent timer — see discoverClaudeSessionId's doc comment
    // for why a timer with no relationship to this session's actual activity
    // can misattribute another tab's file merely by winning an arbitrary race.
    session.cancelDiscovery?.()
    const notifyClaudeOutput =
      opts.provider === 'claude' && !info.claudeSessionId
        ? this.discoverClaudeSessionId(session, cwd, opts.claudeConfigDir)
        : null

    session.activity?.dispose()
    session.activity = new ActivityTracker({
      onBusy: (busy) => this.emit('busy', { id, busy }),
      onAttention: (reason) => this.emit('attention', { id, reason })
    })

    pty.onData((data) => {
      // A restart replaced this pty; whatever the old one still flushes while
      // dying must not be mixed into the new process's stream.
      if (session.pty !== pty) return
      session.activity?.output(data)
      if (!session.loginUrlDone) {
        session.loginUrlBuffer = (session.loginUrlBuffer + stripAnsi(data)).slice(
          -LOGIN_URL_SCAN_LIMIT
        )
        const match = session.loginUrlBuffer.match(LOGIN_URL_RE)
        if (match) {
          session.loginUrlDone = true
          const url = match[0]
          this.emit('login-url', { id, url })
          shell.openExternal(url).catch(() => {
            /* fallback banner in the renderer still lets the user open it manually */
          })
        } else if (session.loginUrlBuffer.length >= LOGIN_URL_SCAN_LIMIT) {
          session.loginUrlDone = true
        }
      }
      if (opts.provider === 'claude') this.trackAuth(session, stripAnsi(data))
      notifyClaudeOutput?.()
      this.pushOutput(session, id, data)
    })
    pty.onExit(({ exitCode }) => {
      if (session.pty !== pty) return // superseded by restart()
      info.status = 'exited'
      info.message = `行程結束 (exit ${exitCode})`
      // The child is gone; drop the handle so a later write/resize/kill can't
      // touch a dead pty. The entry itself stays so the tab can still show its
      // scrollback until the user closes it.
      session.pty = null
      session.cancelDiscovery?.()
      session.activity?.dispose()
      // A finished process is something the user wants to know about too.
      this.emit('busy', { id, busy: false })
      this.emit('attention', { id, reason: 'idle' })
      this.emit('exit', { id, code: exitCode })
      this.emit('status', info)
    })
  }

  /**
   * Keep `info.authState` in step with what the CLI prints. Only the newest
   * output is classified — a rolling tail of a few hundred characters so a
   * message split across chunks still matches — and the tail is dropped on
   * every verdict so an old "run /login" can't keep re-flagging a tab that
   * has since signed in.
   */
  private trackAuth(session: Session, stripped: string): void {
    const text = session.authTail + stripped
    const verdict = classifyAuthOutput(text)
    if (!verdict) {
      session.authTail = text.slice(-AUTH_TAIL_KEEP)
      return
    }
    session.authTail = ''
    const { info } = session
    if (verdict === 'needsLogin' && info.authState !== 'needsLogin') {
      info.authState = 'needsLogin'
      session.authFlaggedAt = Date.now()
      this.emit('status', info)
      this.emit('attention', { id: info.id, reason: 'login' })
    } else if (verdict === 'ok' && info.authState) {
      info.authState = undefined
      this.emit('status', info)
    }
  }

  /**
   * One watcher per Claude account (keyed by its CLAUDE_CONFIG_DIR, '' for
   * the default) on that account's .credentials.json. A write there is the
   * trace of a successful /login — see auth-watch.ts for why that is the
   * moment to restart every other tab of the same account that was stuck.
   */
  private async ensureCredentialsWatch(claudeConfigDir: string | undefined): Promise<void> {
    const key = claudeConfigDir ?? ''
    if (this.credentialWatchers.has(key)) return
    // Reserve the slot before the await so two tabs created back to back
    // can't both get past the check.
    this.credentialWatchers.set(key, () => {})
    const path = await claudeCredentialsPath(claudeConfigDir)
    if (!path) return
    const stop = watchCredentials(path, () => this.onCredentialsChanged(key))
    this.credentialWatchers.set(key, stop)
  }

  private onCredentialsChanged(accountKey: string): void {
    const now = Date.now()
    const stuck = [...this.sessions.values()].filter(
      (s) =>
        s.info.provider === 'claude' &&
        (s.opts.claudeConfigDir ?? '') === accountKey &&
        s.info.authState === 'needsLogin' &&
        s.pty !== null &&
        // The tab the user is signing in from is also flagged until the CLI
        // prints "Login successful", which can land after the file write.
        // Someone typed into it recently; the stuck tabs were left alone.
        now - (s.lastInputAt ?? 0) > RECENT_INPUT_MS
    )
    if (stuck.length === 0) return
    const ids = stuck.map((s) => s.info.id)
    for (const s of stuck) this.restart(s.info.id, '偵測到新的登入，用新憑證重新啟動')
    this.emit('auth-restart', { ids })
  }

  /**
   * Re-spawn a session's process in place: same tab, same terminal, same
   * conversation (resumed by the id discovered earlier). Scrollback in the
   * renderer is untouched; only the process is new. Used after a login in
   * another tab, and from the pane's own "重啟" button.
   */
  restart(id: string, why = '重新啟動'): SessionInfo | null {
    const session = this.sessions.get(id)
    if (!session) return null
    const old = session.pty
    session.pty = null
    session.cancelDiscovery?.()
    session.activity?.dispose()
    if (old) {
      try {
        old.kill()
      } catch {
        /* already gone */
      }
    }
    // Reopen the exact conversation when we know it. Without an id, a tab
    // that had been continuing something keeps continuing it; a brand-new tab
    // that never got as far as a first message just starts fresh — asking
    // for --continue there would attach it to some other conversation in
    // the same folder.
    const sid = session.info.claudeSessionId
    const launch: SessionLaunch = sid
      ? { kind: 'resume', sessionId: sid }
      : session.launch.kind === 'new'
        ? { kind: 'new' }
        : { kind: 'continue' }
    this.pushOutput(session, id, `\r\n\x1b[2m[baguette] ${why}…\x1b[0m\r\n`)
    this.launch(session, launch, session.lastSize ?? {})
    this.emit('status', session.info)
    return session.info
  }

  /**
   * Best-effort: find this session's real Claude-assigned conversation id by
   * watching its project's transcript directory for the `.jsonl` file this
   * particular pty caused to appear or change, and record it as
   * `info.claudeSessionId` once found (see launchArgs's doc comment for why
   * this only works with a REAL captured id, not one invented up front).
   * Returns a `notify()` callback to invoke on every data chunk from this
   * session's own pty. If the transcript directory can't be located, or
   * nothing ever resolves unambiguously, the tab still works exactly as
   * before — just without a precise id, so restore falls back to
   * `--continue`.
   *
   * Deliberately has no expiry: a tab can sit idle for an hour before its
   * first message, and that first message is exactly when there is finally
   * something to discover. Since a check only runs in response to this pty's
   * own output and stops permanently once resolved, "keep watching until it
   * resolves" costs nothing while idle and can't spin.
   *
   * This is intentionally driven by this session's OWN output rather than an
   * independent timer. An earlier version polled on a plain interval and
   * diffed against a per-session baseline, which seemed sound but wasn't: two
   * tabs sharing one cwd each run their own poll loop with no relationship to
   * which tab actually produced a given file change, so whichever tab's timer
   * happened to fire first would win the claim — verified empirically to
   * misattribute even in the ordinary case of two tabs active a few seconds
   * apart, not just a pathological simultaneous one. Checking only when this
   * exact pty just produced output (debounced, so a burst of chunks becomes
   * one check after it goes quiet) ties each check to real evidence that THIS
   * session did something, which is what the old design never actually had.
   * A genuinely simultaneous response from a second tab sharing the cwd is
   * still possible in principle; the shared claimedTranscriptFiles registry
   * (see its own comment) keeps that case safely unresolved rather than
   * guessing, exactly as this always did.
   */
  private discoverClaudeSessionId(session: Session, cwd: string, claudeConfigDir?: string): () => void {
    let cancelled = false
    let resolved = false
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    session.cancelDiscovery = () => {
      cancelled = true
      if (debounceTimer) clearTimeout(debounceTimer)
    }

    const snapshotDir = async (dir: string): Promise<Map<string, number>> => {
      const snap = new Map<string, number>()
      try {
        const entries = await readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
          try {
            snap.set(entry.name, (await stat(join(dir, entry.name))).mtimeMs)
          } catch {
            /* file vanished between readdir and stat; skip it */
          }
        }
      } catch {
        // Directory doesn't exist yet (no message sent in this cwd before) —
        // an empty snapshot is exactly right: any file that later appears is new.
      }
      return snap
    }

    // Locating the directory can need a (cached, warmed) trip into WSL, so it
    // is resolved off the event loop alongside the initial baseline. Both are
    // awaited by the first check that actually runs.
    let baseline: Map<string, number> | null = null
    const ready = claudeProjectDirectory(cwd, claudeConfigDir).then(async (dir) => {
      if (!dir) return null
      baseline = await snapshotDir(dir)
      return dir
    })

    const check = async (): Promise<void> => {
      if (cancelled || resolved) return
      const dir = await ready
      if (!dir || cancelled || resolved) return
      const base = baseline ?? new Map<string, number>()
      const current = await snapshotDir(dir)
      // Everything synchronous from here to the claim itself — no `await` in
      // between — so this can never interleave with another tab's own check
      // between reading claimedTranscriptFiles and adding to it.
      const changed = [...current].filter(
        ([name, mtime]) => (base.get(name) ?? -1) < mtime && !this.claimedTranscriptFiles.has(name)
      )
      if (changed.length === 1) {
        const [name] = changed[0]
        this.claimedTranscriptFiles.add(name)
        resolved = true
        session.info.claudeSessionId = name.slice(0, -'.jsonl'.length)
        this.emit('status', session.info)
        return
      }
      // Ambiguous (nothing changed yet, or more than one unclaimed file did —
      // another tab sharing this cwd responded in the same window) — fold
      // whatever changed into the baseline so it isn't re-flagged on the next
      // real check, and wait for more of this session's own output.
      if (changed.length > 0) baseline = current
    }

    return () => {
      if (cancelled || resolved) return
      if (debounceTimer) clearTimeout(debounceTimer)
      // 1.5s of quiet after the last chunk this pty produced — long enough
      // that a multi-chunk response has finished streaming (and Claude Code
      // has had a moment to flush the transcript write), short enough to
      // resolve well within a normal reply.
      debounceTimer = setTimeout(() => void check(), 1500)
    }
  }

  /** Buffer output, and forward it live once a terminal has attached. */
  private pushOutput(session: Session, id: string, data: string): void {
    session.backlog = (session.backlog + data).slice(-BACKLOG_LIMIT)
    if (session.attached) this.emit('data', { id, data })
    // Unlike 'data', this fires whether or not a terminal is attached: the
    // agent bridge mirrors bridge-opened tabs into a headless terminal, and a
    // tab the user hasn't looked at yet still has to be readable.
    this.emit('output', { id, data })
  }

  /** Everything buffered so far, for a listener that starts after the session did. */
  backlogOf(id: string): string {
    return this.sessions.get(id)?.backlog ?? ''
  }

  /** The pty's current size, or undefined before the first resize. */
  sizeOf(id: string): { cols: number; rows: number } | undefined {
    return this.sessions.get(id)?.lastSize
  }

  /**
   * Called when the renderer's terminal for `id` has mounted and subscribed.
   * Returns everything produced so far and switches the session to live
   * streaming. Nothing is emitted before this point, so the caller can write
   * the returned backlog first and then anything that arrives afterwards,
   * with no gap and no duplication.
   */
  attach(id: string): string {
    const session = this.sessions.get(id)
    if (!session) return ''
    session.attached = true
    return session.backlog
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id)
    session?.activity?.input()
    if (session) session.lastInputAt = Date.now()
    try {
      session?.pty?.write(data)
    } catch {
      /* pty already gone or in a bad state; nothing to surface here */
    }
  }

  /**
   * Every resize that reaches the pty raises SIGWINCH, and a full-screen CLI
   * repaints its entire UI in response. Announcing a size it already has is
   * therefore not free: it costs a repaint, and repaints that land while the
   * previous one is still being written are what leave two half-drawn frames
   * stacked on screen. The renderer already avoids redundant pushes, but this
   * is the choke point every caller goes through, so drop no-ops here too.
   */
  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id)
    const pty = session?.pty
    if (!session || !pty || cols < 1 || rows < 1) return
    const last = session.lastSize
    if (last && last.cols === cols && last.rows === rows) return
    session.lastSize = { cols, rows }
    this.emit('resize', { id, cols, rows })
    try {
      pty.resize(cols, rows)
    } catch {
      /* ignore transient resize errors */
    }
  }

  kill(id: string): void {
    const session = this.sessions.get(id)
    // Stop any pending session-id discovery before dropping the entry: this
    // session is going away, so a debounced check that fires afterwards would
    // only ever write an id onto an object nobody reads.
    session?.cancelDiscovery?.()
    session?.activity?.dispose()
    if (session?.pty) {
      try {
        session.pty.kill()
      } catch {
        /* already gone */
      }
    }
    this.sessions.delete(id)
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info)
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id)
    for (const stop of this.credentialWatchers.values()) stop()
    this.credentialWatchers.clear()
  }
}
