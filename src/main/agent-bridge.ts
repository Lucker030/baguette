import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { unlinkSync } from 'node:fs'
import type { Provider, SessionInfo } from '../shared/types'
import { PROVIDERS } from '../shared/types'
import { writeFileAtomic } from './atomic-write'
import { describeError, log } from './log'

// The agent bridge lets an AI running in one tab (or anywhere else on this
// machine) open another CLI as a real, visible tab, type into it, and read
// what it answers — so the user can sit and watch two agents talk instead of
// the conversation happening in a background process they never see.
//
// Shape: a tiny HTTP server on 127.0.0.1 with a random port and a bearer
// token, both written to `agent-bridge.json` in userData for callers to read.
// Callers in WSL reach it through Windows' own curl.exe, because a WSL2 VM's
// localhost is not the host's.
//
// What a caller may touch is deliberately narrow:
// - only tabs the bridge itself opened (never one the user opened by hand),
// - and those start read-only by default (see readOnlyArgs in launch-mode.ts),
//   so the watched agent can answer but not edit files or run commands.
//
// The same calls also arrive from paired PCs over the LAN (lan.ts), as
// exec() with a Caller naming that device: it sees only the tabs it opened,
// and gets a writable tab only if this PC allowed that for it. The HTTP
// server additionally relays /v1/devices/<id>/tabs/... to a paired PC, so a
// local AI (or the MCP server, mcp.ts) reaches every PC through one port.

/** The slice of PtyManager the bridge needs, structural so tests can fake it. */
export interface BridgePty {
  on(event: 'output', listener: (p: { id: string; data: string }) => void): unknown
  on(event: 'resize', listener: (p: { id: string; cols: number; rows: number }) => void): unknown
  on(event: 'exit', listener: (p: { id: string; code: number }) => void): unknown
  write(id: string, data: string): void
  list(): SessionInfo[]
  backlogOf(id: string): string
  sizeOf(id: string): { cols: number; rows: number } | undefined
}

export interface OpenTabRequest {
  provider: Provider
  name?: string
  cwd?: string
  accountId?: string
  readOnly: boolean
  focus: boolean
}

export interface BridgeDeps {
  pty: BridgePty
  /** Ask the renderer to open a tab exactly as its own UI would; resolves with the session id. */
  openTab(req: OpenTabRequest): Promise<string>
  /** Ask the renderer to close a tab (so its sidebar entry goes away too). */
  closeTab(id: string): void
  /** Where `{port, token}` is published. */
  infoFile: string
  /** LAN control, when it is on (lan.ts). */
  lan?: () => BridgeLan | null
}

/** The slice of LanNode the HTTP server relays to. */
export interface BridgeLan {
  devices(): unknown[]
  call(deviceId: string, call: BridgeCall): Promise<unknown>
  startPairing(): unknown
  cancelPairing(): void
  pair(target: { deviceId?: string; address?: string }, code: string): Promise<unknown>
}

export type BridgeKind = 'list' | 'open' | 'input' | 'screen' | 'wait' | 'close'

/** One bridge operation, whether it came over HTTP or from a paired PC. */
export interface BridgeCall {
  kind: BridgeKind
  /** The tab, for everything but list/open. */
  id?: string
  body: Record<string, unknown>
  /** screen: how many lines. */
  lines?: number
}

/** Who is asking: this PC ('local') or a paired device (its id). */
export interface Caller {
  owner: string
  /** May open tabs that are not read-only. */
  allowWrite: boolean
  /** Shown in the tab name for a remote caller. */
  label?: string
}

export const LOCAL_CALLER: Caller = { owner: 'local', allowWrite: true }

// ---- pure helpers (unit-tested) ----

/**
 * Text to write so a TUI receives `text` as one paste, then Enter.
 *
 * Typing a multi-line message as raw keystrokes would submit at the first
 * newline. Bracketed paste (ESC[200~ … ESC[201~) is how a terminal tells the
 * program "this all arrived at once", and Claude Code, Codex and agy all treat
 * it as a single input. The Enter is returned separately: sent in the same
 * write, some TUIs fold it into the paste instead of submitting.
 */
/**
 * Single keys a caller may press, for the prompts a CLI shows before it takes
 * a message (trust this folder? allow this tool?) — a paste can't answer those.
 */
export const KEYS: Record<string, string> = {
  enter: '\r',
  esc: '\x1b',
  tab: '\t',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  y: 'y',
  n: 'n',
  '1': '1',
  '2': '2',
  '3': '3',
  '4': '4',
  '5': '5',
  '6': '6',
  '7': '7',
  '8': '8',
  '9': '9'
}

export function pasteSequence(text: string): { paste: string; submit: string } {
  // Matching the paste markers necessarily means matching ESC.
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\r\n/g, '\n').replace(/\x1b\[20[01]~/g, '')
  return { paste: `\x1b[200~${clean}\x1b[201~`, submit: '\r' }
}

/**
 * A message the CLI would treat as a command rather than something to answer.
 *
 * Claude Code and Codex run a line starting with `!` as a shell command on the
 * spot, without the model and outside plan mode or the sandbox (Claude itself
 * suggested `! Set-Content ...` when asked to write a file in a bridge tab), and
 * `/` opens slash commands such as /permissions that loosen the session. A
 * bridge caller only gets to talk.
 */
export function isCommandLine(text: string): boolean {
  return /^\s*[!/]/.test(text)
}

/** Trailing blank lines dropped, each line right-trimmed. */
export function tidyLines(lines: string[]): string[] {
  const out = lines.map((l) => l.replace(/\s+$/, ''))
  while (out.length && out[out.length - 1] === '') out.pop()
  return out
}

/**
 * The answer, from the lines a turn produced: everything after the CLI's echo
 * of the caller's message.
 *
 * `lines` should start where the cursor was just before the message was typed
 * (see AgentBridge.input), so nothing from earlier turns is in it. The echo is
 * then the first thing there, and it ends at the first line containing the
 * message's LAST non-empty line — a TUI may wrap or indent the echo, so this
 * matches a trimmed prefix rather than whole lines. Searching from the top
 * matters: an answer that quotes the message (「你說了…」) must not be
 * mistaken for the echo. No echo found → all of `lines`; returning too much
 * beats silently returning nothing.
 */
export function replyAfter(lines: string[], sent: string): string {
  const probe = sent
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .pop()
    ?.slice(0, 40)
  const at = probe ? lines.findIndex((l) => l.includes(probe)) : -1
  return dropInputBox(tidyLines(lines.slice(at + 1)))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n') // the empty rows of a screen the answer didn't fill
    .trim()
}

/** A CLI's empty input line: `>`, `›` or `❯`, alone or followed by placeholder text. */
const PROMPT_LINE = /^\s*[>›❯](\s|$)/
/** A line made only of box-drawing rules (the input box's borders). */
const RULE_LINE = /^[\s─━═╭╮╰╯│┃]*$/

/**
 * The answer without the input box drawn under it. Every CLI here redraws
 * its prompt (and a status line or two) below the answer, so the last prompt
 * line and everything after it is chrome, as are the rules framing it. Only
 * the LAST prompt line counts: a `>` quote inside the answer is followed by
 * more text, the box never is.
 */
export function dropInputBox(lines: string[]): string[] {
  let at = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PROMPT_LINE.test(lines[i])) {
      at = i
      break
    }
  }
  if (at <= 0) return lines
  const out = lines.slice(0, at)
  while (out.length && RULE_LINE.test(out[out.length - 1])) out.pop()
  return out
}

export type Route =
  | { kind: BridgeKind; id?: string; device?: string }
  | { kind: 'devices' }
  | { kind: 'pairing-start' }
  | { kind: 'pairing-stop' }
  | { kind: 'pair' }
  | null

/**
 * `/v1/tabs/...` acts on this PC; `/v1/devices/<id>/tabs/...` on a paired
 * one. `/v1/devices` lists them, `/v1/lan/pairing` shows / withdraws this
 * PC's pairing code and `/v1/lan/pair` pairs with another PC.
 */
export function parseRoute(method: string | undefined, path: string): Route {
  if (/^\/v1\/devices\/?$/.test(path)) return method === 'GET' ? { kind: 'devices' } : null
  if (/^\/v1\/lan\/pairing\/?$/.test(path)) {
    return method === 'POST' ? { kind: 'pairing-start' } : method === 'DELETE' ? { kind: 'pairing-stop' } : null
  }
  if (/^\/v1\/lan\/pair\/?$/.test(path)) return method === 'POST' ? { kind: 'pair' } : null
  const m = /^\/v1(?:\/devices\/([\w-]+))?\/tabs(?:\/([\w-]+)(?:\/(input|screen|wait))?)?\/?$/.exec(path)
  if (!m) return null
  const [, device, id, action] = m
  const at = (r: { kind: BridgeKind; id?: string }): Route => (device ? { ...r, device } : r)
  if (!id) return method === 'GET' ? at({ kind: 'list' }) : method === 'POST' ? at({ kind: 'open' }) : null
  if (!action) return method === 'DELETE' ? at({ kind: 'close', id }) : null
  if (action === 'screen') return method === 'GET' ? at({ kind: 'screen', id }) : null
  if (method !== 'POST') return null
  return action === 'input' ? at({ kind: 'input', id }) : at({ kind: 'wait', id })
}

// ---- headless mirror of each controlled tab ----

type HeadlessTerminal = {
  /** Asynchronous: parsing happens later; `done` fires once this chunk is in the buffer. */
  write(data: string, done?: () => void): void
  resize(cols: number, rows: number): void
  dispose(): void
  buffer: {
    active: {
      type: 'normal' | 'alternate'
      length: number
      baseY: number
      cursorY: number
      getLine(i: number): { translateToString(trim?: boolean): string } | undefined
    }
  }
}
type HeadlessModule = {
  Terminal: new (opts: Record<string, unknown>) => HeadlessTerminal
}

let headless: HeadlessModule | null = null
function loadHeadless(): HeadlessModule {
  // Same lazy-require pattern as node-pty: a CJS package, loaded on first use.
  if (!headless) headless = createRequire(import.meta.url)('@xterm/headless') as HeadlessModule
  return headless
}

interface Controlled {
  id: string
  provider: Provider
  name: string
  /** Caller.owner of whoever opened it. */
  owner: string
  readOnly: boolean
  term: HeadlessTerminal
  lastOutput: number
  outputSince: number
  exited: boolean
  createdAt: number
}

const MAX_BODY = 1_000_000
const SCROLLBACK = 5000

export class AgentBridge {
  private server: Server | null = null
  private token = ''
  private tabs = new Map<string, Controlled>()

  constructor(private readonly deps: BridgeDeps) {
    deps.pty.on('output', ({ id, data }) => {
      const t = this.tabs.get(id)
      if (!t) return
      t.term.write(data)
      t.lastOutput = Date.now()
      t.outputSince++
    })
    deps.pty.on('resize', ({ id, cols, rows }) => this.tabs.get(id)?.term.resize(cols, rows))
    deps.pty.on('exit', ({ id }) => {
      const t = this.tabs.get(id)
      if (t) t.exited = true
    })
  }

  start(): Promise<void> {
    if (this.server) return Promise.resolve()
    this.token = randomBytes(32).toString('hex')
    const server = createServer((req, res) => void this.handle(req, res))
    this.server = server
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        writeFileAtomic(
          this.deps.infoFile,
          JSON.stringify({ port, token: this.token, pid: process.pid, version: 1 }, null, 2)
        )
        log.info(`agent bridge listening on 127.0.0.1:${port}`)
        resolve()
      })
    })
  }

  stop(): void {
    this.server?.close()
    this.server = null
    try {
      unlinkSync(this.deps.infoFile)
    } catch {
      /* never written, or already gone */
    }
    for (const t of this.tabs.values()) t.term.dispose()
    this.tabs.clear()
  }

  /** Forget a tab the user closed by hand. */
  forget(id: string): void {
    this.tabs.get(id)?.term.dispose()
    this.tabs.delete(id)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    try {
      // A page in a browser could reach 127.0.0.1 too; it can't add this
      // header without a CORS preflight we never answer, and any request
      // carrying an Origin is refused outright.
      if (req.headers.origin || req.headers.authorization !== `Bearer ${this.token}`) {
        return send(401, { error: 'unauthorized' })
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const route = parseRoute(req.method, url.pathname)
      if (!route) return send(404, { error: 'no such endpoint' })
      const body = req.method === 'POST' ? await readJson(req) : {}

      if (route.kind === 'devices' || route.kind === 'pairing-start' || route.kind === 'pairing-stop' || route.kind === 'pair') {
        const lan = this.deps.lan?.() ?? null
        if (!lan) throw new HttpError(409, 'LAN control is off (baguette → 內網裝置 → 啟用)')
        if (route.kind === 'devices') return send(200, { devices: lan.devices() })
        if (route.kind === 'pairing-start') return send(200, lan.startPairing())
        if (route.kind === 'pairing-stop') {
          lan.cancelPairing()
          return send(200, { stopped: true })
        }
        const target = {
          deviceId: typeof body.device === 'string' ? body.device : undefined,
          address: typeof body.address === 'string' ? body.address : undefined
        }
        return send(200, await lan.pair(target, typeof body.code === 'string' ? body.code : String(body.code ?? '')))
      }

      const call: BridgeCall = {
        kind: route.kind,
        id: route.id,
        body,
        lines: clampInt(url.searchParams.get('lines'), 1, SCROLLBACK, 60)
      }
      if (route.device) {
        const lan = this.deps.lan?.() ?? null
        if (!lan) throw new HttpError(409, 'LAN control is off (baguette → 內網裝置 → 啟用)')
        return send(200, await lan.call(route.device, call))
      }
      return send(200, await this.exec(call, LOCAL_CALLER))
    } catch (e) {
      const status = typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : 500
      if (status === 500) log.error(`agent bridge: ${describeError(e)}`)
      send(status, { error: e instanceof Error ? e.message : String(e) })
    }
  }

  /** One bridge operation for `caller`; throws HttpError for the caller's mistakes. */
  async exec(call: BridgeCall, caller: Caller): Promise<unknown> {
    const { body } = call
    switch (call.kind) {
      case 'list':
        return { tabs: [...this.tabs.values()].filter((t) => this.visibleTo(t, caller)).map((t) => this.describe(t)) }
      case 'open':
        return this.open(body, caller)
      case 'close': {
        const t = this.mustGet(call.id, caller)
        this.deps.closeTab(t.id)
        this.forget(t.id)
        return { closed: t.id }
      }
      case 'screen': {
        const t = this.mustGet(call.id, caller)
        const lines = clampInt(call.lines ?? body.lines, 1, SCROLLBACK, 60)
        return { ...this.describe(t), screen: (await this.screen(t, lines)).join('\n') }
      }
      case 'input': {
        const t = this.mustGet(call.id, caller)
        if (typeof body.key === 'string') {
          const seq = KEYS[body.key]
          if (!seq) throw new HttpError(400, `key must be one of ${Object.keys(KEYS).join(', ')}`)
          if (t.exited) throw new HttpError(409, `tab ${t.id} has exited`)
          this.deps.pty.write(t.id, seq)
          const waited = await this.waitQuiet(t, { quietMs: 1500, startMs: 5000, ...body })
          return { ...this.describe(t), ...waited, screen: (await this.screen(t, 60)).join('\n') }
        }
        const text = typeof body.text === 'string' ? body.text : ''
        if (!text) throw new HttpError(400, 'text (or key) is required')
        if (isCommandLine(text)) {
          throw new HttpError(400, 'messages may not start with ! or / (shell and slash commands bypass read-only)')
        }
        // Where this turn starts, so the reply can't include earlier turns.
        const from = await this.cursorLine(t)
        await this.type(t, text, body.submit !== false)
        if (body.wait === false) return { sent: true }
        const waited = await this.waitQuiet(t, body)
        return { ...this.describe(t), ...waited, reply: replyAfter(await this.linesFrom(t, from), text) }
      }
      case 'wait': {
        const t = this.mustGet(call.id, caller)
        const waited = await this.waitQuiet(t, body, true)
        return { ...this.describe(t), ...waited, screen: (await this.screen(t, 60)).join('\n') }
      }
    }
  }

  /** This PC sees every bridge tab; a paired PC only the ones it opened. */
  private visibleTo(t: Controlled, caller: Caller): boolean {
    return caller.owner === LOCAL_CALLER.owner || t.owner === caller.owner
  }

  private async open(body: Record<string, unknown>, caller: Caller): Promise<unknown> {
    const provider = PROVIDERS.find((p) => p === body.provider)
    if (!provider || provider === 'shell') {
      throw new HttpError(400, `provider must be one of ${PROVIDERS.filter((p) => p !== 'shell').join(', ')}`)
    }
    // Read-only unless the caller explicitly asks otherwise — and only a
    // caller this PC allows may ask (a paired PC needs allowWrite).
    const readOnly = body.readOnly !== false
    if (!readOnly && !caller.allowWrite) {
      throw new HttpError(403, 'this PC only allows you read-only tabs (內網裝置 → 允許開可寫入的分頁)')
    }
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 40) : provider
    const id = await this.deps.openTab({
      provider,
      // A remote caller's tabs say whose they are, for whoever sits at this PC.
      // (They are told apart from the user's own tabs by their sidebar group,
      // AI_GROUP_NAME in the renderer's store.)
      name: caller.label ? `${caller.label.slice(0, 20)}／${name}` : name,
      cwd: typeof body.cwd === 'string' && body.cwd ? body.cwd : undefined,
      accountId: typeof body.accountId === 'string' ? body.accountId : undefined,
      readOnly,
      // Always brought to the front: watching is the point.
      focus: true
    })
    const size = this.deps.pty.sizeOf(id) ?? { cols: 80, rows: 24 }
    log.info(`agent bridge: opened ${id} at ${size.cols}x${size.rows}`)
    const term = new (loadHeadless().Terminal)({
      cols: size.cols,
      rows: size.rows,
      scrollback: SCROLLBACK,
      allowProposedApi: true
    })
    // Output produced before we got here (the CLI's banner) is in the backlog.
    term.write(this.deps.pty.backlogOf(id))
    const t: Controlled = {
      id,
      provider,
      name,
      owner: caller.owner,
      readOnly,
      term,
      lastOutput: Date.now(),
      outputSince: 0,
      exited: false,
      createdAt: Date.now()
    }
    this.tabs.set(id, t)
    // A fresh CLI needs a moment to draw its input box before it can take a paste.
    const ready = await this.waitQuiet(t, { quietMs: 1500, timeoutMs: 60_000, startMs: 15_000 }, true)
    return { ...this.describe(t), ready: ready.settled }
  }

  private mustGet(id: string | undefined, caller: Caller): Controlled {
    const t = id ? this.tabs.get(id) : undefined
    if (!t || !this.visibleTo(t, caller)) throw new HttpError(404, `tab ${id} was not opened by you through the bridge (or is closed)`)
    return t
  }

  private describe(t: Controlled): Record<string, unknown> {
    const info = this.deps.pty.list().find((s) => s.id === t.id)
    const size = this.deps.pty.sizeOf(t.id)
    return {
      id: t.id,
      provider: t.provider,
      name: t.name,
      status: info?.status ?? 'closed',
      readOnly: t.readOnly,
      exited: t.exited,
      cols: size?.cols,
      rows: size?.rows
    }
  }

  private async type(t: Controlled, text: string, submit: boolean): Promise<void> {
    if (t.exited) throw new HttpError(409, `tab ${t.id} has exited`)
    const { paste, submit: enter } = pasteSequence(text)
    this.deps.pty.write(t.id, paste)
    if (submit) {
      await sleep(250)
      this.deps.pty.write(t.id, enter)
    }
  }

  /**
   * Wait until the tab has produced output and then gone quiet.
   *
   * Every CLI here animates a spinner or streams text while it works and stops
   * drawing when it is done (or stopped at a permission prompt), so silence is
   * the signal — the same idea as activity.ts, with a longer quiet window
   * because a slow model can pause mid-answer. `startMs` bounds how long to
   * wait for anything to happen at all; `anyOutput` lets the open() handshake
   * count the banner already in flight.
   */
  private async waitQuiet(
    t: Controlled,
    opts: Record<string, unknown>,
    anyOutput = false
  ): Promise<{ settled: boolean; waitedMs: number }> {
    const quietMs = clampInt(opts.quietMs, 300, 60_000, 4000)
    const timeoutMs = clampInt(opts.timeoutMs, 1000, 3_600_000, 600_000)
    const startMs = clampInt(opts.startMs, 500, 600_000, 30_000)
    const t0 = Date.now()
    const before = anyOutput ? -1 : t.outputSince
    for (;;) {
      await sleep(200)
      const now = Date.now()
      const started = t.outputSince > before
      if (t.exited) return { settled: true, waitedMs: now - t0 }
      if (started && now - t.lastOutput >= quietMs) return { settled: true, waitedMs: now - t0 }
      if (!started && now - t0 >= startMs) return { settled: false, waitedMs: now - t0 }
      if (now - t0 >= timeoutMs) return { settled: false, waitedMs: now - t0 }
    }
  }

  /** Resolves once every chunk written so far has been parsed into the buffer. */
  private flush(t: Controlled): Promise<void> {
    return new Promise((resolve) => t.term.write('', resolve))
  }

  /**
   * Where to start looking for this turn's echo: the top of the screen the
   * cursor is on. Not the cursor's own line — Codex keeps the cursor in an
   * input box pinned to the bottom and inserts the conversation ABOVE it, so
   * the echo lands higher than where the cursor was (verified). The echo
   * search in replyAfter skips whatever earlier text this window takes in.
   * A full-screen (alternate-buffer) TUI redraws in place instead of
   * scrolling, so there "the lines after" means nothing; -1 tells linesFrom
   * to use the whole screen.
   */
  private async cursorLine(t: Controlled): Promise<number> {
    await this.flush(t)
    const buf = t.term.buffer.active
    return buf.type === 'alternate' ? -1 : buf.baseY
  }

  private async linesFrom(t: Controlled, from: number): Promise<string[]> {
    await this.flush(t)
    const buf = t.term.buffer.active
    // Scrollback may have dropped lines since `from` was taken; clamp, and
    // fall back to the visible screen for full-screen TUIs.
    const start = from < 0 || buf.type === 'alternate' ? buf.baseY : Math.max(0, Math.min(from, buf.length - 1))
    const out: string[] = []
    for (let i = start; i < buf.length; i++) out.push(buf.getLine(i)?.translateToString(true) ?? '')
    return tidyLines(out)
  }

  /** The last `lines` lines that have anything on them (a fresh screen is mostly blank rows). */
  private async screen(t: Controlled, lines: number): Promise<string[]> {
    const all = await this.linesFrom(t, 0)
    return all.slice(-lines)
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v ? Number(v) : NaN
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'body too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
      } catch {
        reject(new HttpError(400, 'body must be JSON'))
      }
    })
    req.on('error', reject)
  })
}
