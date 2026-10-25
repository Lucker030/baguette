import { EventEmitter } from 'node:events'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import type { LanDevice, LanStatus, SyncCategory } from '../shared/types'
import { SYNC_CATEGORIES } from '../shared/types'
import type { BridgeCall, BridgeKind, Caller } from './agent-bridge'
import {
  FrameCipher,
  FrameReader,
  cpaceFinish,
  cpaceStart,
  encodeFrame,
  handshakeTranscript,
  helloMac,
  macEqual,
  newEphemeral,
  newPairingCode,
  pairMac,
  pairingSecret,
  sessionKeys
} from './lan-crypto'

// LAN control: baguette instances on the same network find each other, pair
// with a 6-digit code, and then let an AI on one PC drive agent-bridge tabs
// on the other — the same calls the local bridge serves (open a tab, type,
// read the screen), carried over an encrypted TCP connection instead of
// 127.0.0.1.
//
// - Discovery: a UDP broadcast every ANNOUNCE_MS on DISCOVERY_PORT. A device
//   that can't be heard (another subnet, broadcast blocked) can still be added
//   by IP: `whoami` over TCP.
// - Pairing: the target shows a code (startPairing) and accepts pair requests
//   while it is up; the controller sends the code through CPace (lan-crypto.ts).
//   Both sides then store each other with a shared secret.
// - Sessions: each connection is authenticated with that secret plus a fresh
//   X25519 exchange, then every frame is AES-256-GCM.
// - What a peer may do on this PC: only bridge calls, only on tabs it opened
//   itself, read-only unless this PC turned on allowWrite for it. Same rules
//   as agent-bridge.ts otherwise.
//
// No Electron imports: storage, the bridge and the device name come in as
// LanDeps, so tests can run two nodes against each other on localhost.

export const LAN_PORT = 47610
export const DISCOVERY_PORT = 47611
const ANNOUNCE_MS = 10_000
/** A device not heard from in this long is shown offline. */
const SEEN_TTL_MS = 35_000
const PAIR_CODE_MS = 120_000
/** Wrong codes the target accepts before it withdraws the code. */
const PAIR_ATTEMPTS = 3
const HANDSHAKE_MS = 10_000
const CONNECT_MS = 5_000
const IDLE_CLOSE_MS = 5 * 60_000
const PROTOCOL_VERSION = 1

export interface StoredPeer {
  id: string
  name: string
  /** Base64 pairing secret. */
  secret: string
  address?: string
  port?: number
  /** This PC lets the peer open writable tabs here. */
  allowWrite: boolean
  pairedAt: number
  /** What this PC ticked for syncing with the peer (lan-sync.ts). */
  sync?: Partial<Record<SyncCategory, boolean>>
  /** What the peer last told us it ticked for this PC. */
  peerSync?: Partial<Record<SyncCategory, boolean>>
}

export interface LanState {
  deviceId: string
  peers: StoredPeer[]
}

export interface LanStore {
  load(): LanState
  save(state: LanState): void
}

export interface LanDeps {
  store: LanStore
  deviceName(): string
  version: string
  /** Run a bridge call for a paired device (AgentBridge.exec). */
  exec(call: BridgeCall, caller: Caller): Promise<unknown>
  /** `sync.*` calls from a paired device (LanSync.serve). */
  syncServe?: (peerId: string, method: string, params: unknown) => Promise<unknown>
  log: { info(msg: string): void; warn(msg: string): void }
  /** Tests: 0 for any free port. */
  port?: number
  /** Tests: false keeps UDP discovery off. */
  discovery?: boolean
}

/** An error from the other side (or about it), with the HTTP-style status the bridge uses. */
export class LanError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

interface Seen {
  id: string
  name: string
  address: string
  port: number
  version?: string
  lastSeen: number
}

type Json = Record<string, unknown>

const BRIDGE_KINDS: BridgeKind[] = ['list', 'open', 'input', 'screen', 'wait', 'close']

/** "192.168.0.124" or "192.168.0.124:47610". */
export function parseAddress(text: string): { address: string; port: number } | null {
  const m = /^\s*(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?\s*$/.exec(text)
  if (!m) return null
  if (m[1].split('.').some((o) => Number(o) > 255)) return null
  const port = m[2] ? Number(m[2]) : LAN_PORT
  return port > 0 && port < 65536 ? { address: m[1], port } : null
}

/** Each IPv4 interface's directed broadcast address, plus the limited one. */
export function broadcastAddresses(ifaces = os.networkInterfaces()): string[] {
  const out = new Set<string>(['255.255.255.255'])
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue
      const a = i.address.split('.').map(Number)
      const m = i.netmask.split('.').map(Number)
      out.add(a.map((o, k) => (o | (~m[k] & 255)) & 255).join('.'))
    }
  }
  return [...out]
}

function localAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) out.push(i.address)
  }
  return out
}

function b64(b: Uint8Array): string {
  return Buffer.from(b).toString('base64')
}

function unb64(v: unknown, len?: number): Buffer {
  const b = typeof v === 'string' ? Buffer.from(v, 'base64') : Buffer.alloc(0)
  if (len !== undefined && b.length !== len) throw new LanError(400, 'malformed message')
  return b
}

function str(v: unknown, max = 200): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

// ---- framed socket ----

/**
 * A socket carrying length-prefixed frames: plaintext JSON during the
 * handshake (read with next()), sealed frames after encrypt(). Frames that
 * arrive before encryption is switched on are kept raw, because the peer may
 * send its first sealed frame right behind its last handshake message.
 */
class Wire {
  private reader = new FrameReader()
  private queue: Buffer[] = []
  private waiter: { resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null
  private sealer: FrameCipher | null = null
  private opener: FrameCipher | null = null
  private onFrame: ((plain: Buffer) => void) | null = null
  private closeHandlers: ((err?: Error) => void)[] = []
  closed = false

  constructor(readonly sock: Socket) {
    sock.setNoDelay(true)
    sock.on('data', (chunk: Buffer) => {
      try {
        for (const f of this.reader.push(chunk)) this.deliver(f)
      } catch (e) {
        this.close(e as Error)
      }
    })
    sock.on('error', (e) => this.close(e))
    sock.on('close', () => this.close())
  }

  private deliver(raw: Buffer): void {
    if (this.onFrame && this.opener) return this.onFrame(this.opener.open(raw))
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      return w.resolve(raw)
    }
    this.queue.push(raw)
  }

  next(timeoutMs = HANDSHAKE_MS): Promise<Json> {
    const parse = (raw: Buffer): Json => {
      const v: unknown = JSON.parse(raw.toString('utf8'))
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new LanError(400, 'malformed message')
      const msg = v as Json
      if (msg.t === 'error') throw new LanError(Number(msg.status) || 403, str(msg.message, 500) || '對方拒絕了連線')
      return msg
    }
    const queued = this.queue.shift()
    if (queued) return Promise.resolve().then(() => parse(queued))
    if (this.closed) return Promise.reject(new LanError(502, '連線已中斷'))
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null
        reject(new LanError(504, '對方沒有回應'))
        this.close()
      }, timeoutMs)
      this.waiter = {
        resolve: (b) => {
          clearTimeout(timer)
          resolve(b)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      }
    }).then(parse)
  }

  sendPlain(msg: Json): void {
    if (!this.closed) this.sock.write(encodeFrame(Buffer.from(JSON.stringify(msg), 'utf8')))
  }

  /** Report an error to the other side and hang up. */
  refuse(status: number, message: string): void {
    this.sendPlain({ t: 'error', status, message })
    this.sock.end()
  }

  encrypt(sealKey: Buffer, openKey: Buffer, onFrame: (plain: Buffer) => void): void {
    this.sealer = new FrameCipher(sealKey)
    this.opener = new FrameCipher(openKey)
    this.onFrame = onFrame
    const pending = this.queue
    this.queue = []
    try {
      for (const raw of pending) onFrame(this.opener.open(raw))
    } catch (e) {
      this.close(e as Error)
    }
  }

  sendSealed(msg: unknown): void {
    if (this.closed || !this.sealer) return
    this.sock.write(encodeFrame(this.sealer.seal(Buffer.from(JSON.stringify(msg), 'utf8'))))
  }

  onClose(fn: (err?: Error) => void): void {
    if (this.closed) fn()
    else this.closeHandlers.push(fn)
  }

  close(err?: Error): void {
    if (this.closed) return
    this.closed = true
    this.sock.destroy()
    this.waiter?.reject(err instanceof LanError ? err : new LanError(502, '連線已中斷'))
    this.waiter = null
    for (const fn of this.closeHandlers.splice(0)) fn(err)
  }
}

function dial(address: string, port: number): Promise<Wire> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: address, port })
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new LanError(504, `連不到 ${address}:${port}`))
    }, CONNECT_MS)
    sock.once('connect', () => {
      clearTimeout(timer)
      resolve(new Wire(sock))
    })
    sock.once('error', (e) => {
      clearTimeout(timer)
      reject(new LanError(502, `連不到 ${address}:${port}（${e.message}）`))
    })
  })
}

// ---- authenticated session (RPC over a sealed wire) ----

type Handler = (method: string, params: unknown) => Promise<unknown>

class Session {
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private idleTimer: NodeJS.Timeout | null = null

  constructor(
    readonly peerId: string,
    readonly wire: Wire,
    sealKey: Buffer,
    openKey: Buffer,
    private readonly handler: Handler
  ) {
    wire.onClose(() => {
      for (const p of this.pending.values()) p.reject(new LanError(502, '和對方的連線中斷了'))
      this.pending.clear()
      if (this.idleTimer) clearTimeout(this.idleTimer)
    })
    wire.encrypt(sealKey, openKey, (plain) => this.onMessage(plain))
  }

  get closed(): boolean {
    return this.wire.closed
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.wire.closed) return Promise.reject(new LanError(502, '和對方的連線中斷了'))
    const id = this.nextId++
    this.touch()
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.wire.sendSealed({ k: 'req', id, m: method, p: params })
    })
  }

  /** Close a connection nobody has used for a while (the peer may be asleep). */
  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0) this.wire.close()
      else this.touch()
    }, IDLE_CLOSE_MS)
  }

  private onMessage(plain: Buffer): void {
    const msg = JSON.parse(plain.toString('utf8')) as Json
    if (msg.k === 'res') {
      const p = this.pending.get(Number(msg.id))
      if (!p) return
      this.pending.delete(Number(msg.id))
      if (msg.ok) p.resolve(msg.r)
      else {
        const e = (msg.e ?? {}) as Json
        p.reject(new LanError(Number(e.status) || 500, str(e.message, 2000) || '對方發生錯誤'))
      }
      return
    }
    if (msg.k === 'req') {
      const id = msg.id
      this.touch()
      this.handler(str(msg.m, 40), msg.p).then(
        (r) => this.wire.sendSealed({ k: 'res', id, ok: true, r }),
        (e: unknown) => {
          const status = typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : 500
          this.wire.sendSealed({ k: 'res', id, ok: false, e: { status, message: e instanceof Error ? e.message : String(e) } })
        }
      )
    }
  }
}

// ---- the node ----

export class LanNode extends EventEmitter {
  private state: LanState
  private server: Server | null = null
  private udp: UdpSocket | null = null
  private announceTimer: NodeJS.Timeout | null = null
  private port = 0
  private error: string | undefined
  private seen = new Map<string, Seen>()
  private outgoing = new Map<string, Promise<Session>>()
  private incoming = new Set<Session>()
  /** Peers we hold an open outgoing session to. */
  private connectedOut = new Set<string>()
  private pairing: { code: string; expiresAt: number; attempts: number } | null = null
  private pairingTimer: NodeJS.Timeout | null = null

  constructor(private readonly deps: LanDeps) {
    super()
    this.state = deps.store.load()
  }

  get running(): boolean {
    return this.server !== null
  }

  get deviceId(): string {
    return this.state.deviceId
  }

  async start(): Promise<void> {
    if (this.server) return
    this.error = undefined
    const server = createServer((sock) => void this.accept(sock))
    try {
      this.port = await listen(server, this.deps.port ?? LAN_PORT)
    } catch (e) {
      // Taken (another program, or a second instance in tests): any port
      // works, since discovery announces the real one — only a manually
      // added address assumes the default.
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || this.deps.port === 0) {
        this.error = `無法開啟內網連線：${(e as Error).message}`
        this.emit('changed')
        throw e
      }
      this.deps.log.warn(`lan: port ${LAN_PORT} in use, using a random one`)
      this.port = await listen(server, 0)
    }
    this.server = server
    this.deps.log.info(`lan: listening on port ${this.port} as ${this.state.deviceId}`)
    if (this.deps.discovery !== false) this.startDiscovery()
    this.emit('changed')
  }

  stop(): void {
    this.server?.close()
    this.server = null
    if (this.announceTimer) clearInterval(this.announceTimer)
    this.announceTimer = null
    try {
      this.udp?.close()
    } catch {
      /* already closed */
    }
    this.udp = null
    for (const s of this.outgoing.values()) void s.then((x) => x.wire.close(), () => {})
    this.outgoing.clear()
    for (const s of this.incoming) s.wire.close()
    this.incoming.clear()
    this.cancelPairing()
    this.seen.clear()
    this.emit('changed')
  }

  status(): LanStatus {
    return {
      running: this.running,
      deviceId: this.state.deviceId,
      deviceName: this.deps.deviceName(),
      port: this.running ? this.port : undefined,
      addresses: this.running ? localAddresses() : [],
      pairing: this.pairing ? { code: this.pairing.code, expiresAt: this.pairing.expiresAt } : null,
      error: this.error
    }
  }

  devices(): LanDevice[] {
    const now = Date.now()
    const out: LanDevice[] = []
    for (const p of this.state.peers) {
      const s = this.seen.get(p.id)
      const fresh = s && now - s.lastSeen < SEEN_TTL_MS
      const connected = this.connectedOut.has(p.id) || [...this.incoming].some((x) => x.peerId === p.id && !x.closed)
      out.push({
        id: p.id,
        name: p.name,
        address: s?.address ?? p.address,
        port: s?.port ?? p.port,
        paired: true,
        online: Boolean(fresh || connected),
        allowWrite: p.allowWrite,
        version: s?.version,
        sync: Object.fromEntries(
          SYNC_CATEGORIES.map((c) => [c, { mine: p.sync?.[c] === true, theirs: p.peerSync?.[c] === true }])
        ) as LanDevice['sync']
      })
    }
    for (const s of this.seen.values()) {
      if (this.peer(s.id) || now - s.lastSeen >= SEEN_TTL_MS) continue
      out.push({ id: s.id, name: s.name, address: s.address, port: s.port, paired: false, online: true, version: s.version })
    }
    return out
  }

  // ---- pairing ----

  /** Show a code on this PC and accept pair requests until it expires. */
  startPairing(): { code: string; expiresAt: number } {
    if (!this.running) throw new LanError(409, '內網連線沒有開啟')
    this.cancelPairing()
    const p = { code: newPairingCode(), expiresAt: Date.now() + PAIR_CODE_MS, attempts: 0 }
    this.pairing = p
    this.pairingTimer = setTimeout(() => this.cancelPairing(), PAIR_CODE_MS)
    this.emit('changed')
    return { code: p.code, expiresAt: p.expiresAt }
  }

  cancelPairing(): void {
    if (this.pairingTimer) clearTimeout(this.pairingTimer)
    this.pairingTimer = null
    if (this.pairing) {
      this.pairing = null
      this.emit('changed')
    }
  }

  /** Pair with a device showing `code`, found by discovery (deviceId) or typed in (address). */
  async pair(target: { deviceId?: string; address?: string }, code: string): Promise<LanDevice> {
    if (!this.running) throw new LanError(409, '內網連線沒有開啟')
    if (!/^\d{6}$/.test(code.trim())) throw new LanError(400, '配對碼是 6 位數字')
    const where = this.resolveTarget(target)
    const wire = await dial(where.address, where.port)
    try {
      const sid = randomBytes(16)
      const cp = cpaceStart(code.trim(), sid)
      const me = { id: this.state.deviceId, name: this.deps.deviceName() }
      wire.sendPlain({ t: 'pair', v: PROTOCOL_VERSION, id: me.id, name: me.name, port: this.port, sid: b64(sid), y: b64(cp.share) })
      const r = await wire.next()
      if (r.t !== 'pair-ok') throw new LanError(502, '對方的回應不正確')
      const peerId = str(r.id, 64)
      const peerName = str(r.name, 80) || where.address
      const peerShare = unb64(r.y, 32)
      const transcript = JSON.stringify([b64(sid), me.id, me.name, peerId, peerName, b64(cp.share), b64(peerShare)])
      let isk: Buffer
      try {
        isk = cpaceFinish(cp, peerShare, sid, cp.share, peerShare)
      } catch {
        throw new LanError(502, '對方的回應不正確')
      }
      if (!macEqual(unb64(r.mac), pairMac(isk, 'responder', transcript))) {
        throw new LanError(403, '配對碼不對（或已過期），請看對方畫面上的碼再試一次')
      }
      wire.sendPlain({ t: 'pair-confirm', mac: b64(pairMac(isk, 'initiator', transcript)) })
      const done = await wire.next()
      if (done.t !== 'paired') throw new LanError(502, '對方沒有完成配對')
      this.savePeer({
        id: peerId,
        name: peerName,
        secret: b64(pairingSecret(isk)),
        address: where.address,
        port: where.port,
        allowWrite: false,
        pairedAt: Date.now()
      })
      this.deps.log.info(`lan: paired with ${peerName} (${peerId}) at ${where.address}`)
      return this.devices().find((d) => d.id === peerId) as LanDevice
    } finally {
      wire.close()
    }
  }

  /** Look up a device by IP (for networks where broadcasts don't arrive). */
  async probe(text: string): Promise<LanDevice> {
    const where = parseAddress(text)
    if (!where) throw new LanError(400, '請輸入 IP，例如 192.168.0.124')
    const wire = await dial(where.address, where.port)
    try {
      wire.sendPlain({ t: 'whoami', v: PROTOCOL_VERSION })
      const r = await wire.next()
      const id = str(r.id, 64)
      if (r.t !== 'whoami' || !id) throw new LanError(502, '那個位址不是 baguette')
      if (id === this.state.deviceId) throw new LanError(400, '那是這台電腦自己')
      this.noteSeen({ id, name: str(r.name, 80) || where.address, address: where.address, port: where.port, version: str(r.version, 20) })
      return this.devices().find((d) => d.id === id) as LanDevice
    } finally {
      wire.close()
    }
  }

  async unpair(id: string): Promise<void> {
    const peer = this.peer(id)
    if (!peer) return
    // Tell the other side too, so it doesn't keep listing a pairing that
    // can no longer connect. Best effort: it may be off.
    try {
      const s = await Promise.race([this.session(peer), sleep(3000).then(() => null)])
      await s?.request('unpair', {})
    } catch {
      /* offline; it finds out on its next connection attempt */
    }
    this.forgetPeer(id)
  }

  setAllowWrite(id: string, allow: boolean): void {
    const peer = this.peer(id)
    if (!peer) return
    peer.allowWrite = allow
    this.persist()
    this.emit('changed')
  }

  /** Run a bridge call on a paired device. */
  call(deviceId: string, call: BridgeCall): Promise<unknown> {
    return this.request(deviceId, 'bridge', call)
  }

  /** Any call to a paired device (bridge, sync.*), by id or name. */
  async request(deviceId: string, method: string, params: unknown): Promise<unknown> {
    if (!this.running) throw new LanError(409, '內網連線沒有開啟（內網裝置 → 啟用）')
    const peer = this.peer(deviceId) ?? this.state.peers.find((p) => p.name.toLowerCase() === deviceId.toLowerCase())
    if (!peer) throw new LanError(404, `沒有配對過的裝置：${deviceId}`)
    const s = await this.session(peer)
    return s.request(method, params)
  }

  /** Paired peers with their sync ticks, for LanSync. */
  syncPeers(): {
    id: string
    name: string
    online: boolean
    mine: Partial<Record<SyncCategory, boolean>>
    theirs: Partial<Record<SyncCategory, boolean>>
  }[] {
    const online = new Map(this.devices().map((d) => [d.id, d.online]))
    return this.state.peers.map((p) => ({ id: p.id, name: p.name, online: online.get(p.id) === true, mine: { ...p.sync }, theirs: { ...p.peerSync } }))
  }

  setSyncFlag(id: string, cat: SyncCategory, on: boolean): void {
    const peer = this.peer(id)
    if (!peer) return
    peer.sync = { ...peer.sync, [cat]: on }
    this.persist()
    this.emit('changed')
  }

  setPeerSync(id: string, flags: Partial<Record<SyncCategory, boolean>>): void {
    const peer = this.peer(id)
    if (!peer) return
    peer.peerSync = { ...flags }
    this.persist()
    this.emit('changed')
  }

  // ---- internals ----

  private peer(id: string): StoredPeer | undefined {
    return this.state.peers.find((p) => p.id === id)
  }

  private persist(): void {
    this.deps.store.save(this.state)
  }

  private savePeer(peer: StoredPeer): void {
    this.dropSessions(peer.id)
    this.state = { ...this.state, peers: [...this.state.peers.filter((p) => p.id !== peer.id), peer] }
    this.persist()
    this.emit('changed')
    this.emit('paired', { id: peer.id, name: peer.name })
  }

  private forgetPeer(id: string): void {
    this.state = { ...this.state, peers: this.state.peers.filter((p) => p.id !== id) }
    this.persist()
    this.dropSessions(id)
    this.emit('changed')
  }

  private dropSessions(id: string): void {
    const out = this.outgoing.get(id)
    this.outgoing.delete(id)
    void out?.then((s) => s.wire.close(), () => {})
    for (const s of this.incoming) if (s.peerId === id) s.wire.close()
  }

  private resolveTarget(target: { deviceId?: string; address?: string }): { address: string; port: number } {
    if (target.address) {
      const where = parseAddress(target.address)
      if (!where) throw new LanError(400, '請輸入 IP，例如 192.168.0.124')
      return where
    }
    const s = target.deviceId ? this.seen.get(target.deviceId) : undefined
    if (s) return { address: s.address, port: s.port }
    const p = target.deviceId ? this.peer(target.deviceId) : undefined
    if (p?.address) return { address: p.address, port: p.port ?? LAN_PORT }
    throw new LanError(404, '找不到那台裝置（它還開著嗎？）')
  }

  /** One outgoing session per peer, reused until it closes. */
  private session(peer: StoredPeer): Promise<Session> {
    const existing = this.outgoing.get(peer.id)
    if (existing) {
      return existing.then(
        (s) => (s.closed ? this.openSession(peer) : s),
        () => this.openSession(peer)
      )
    }
    return this.openSession(peer)
  }

  private openSession(peer: StoredPeer): Promise<Session> {
    const p = this.handshake(peer)
    this.outgoing.set(peer.id, p)
    p.catch(() => {
      if (this.outgoing.get(peer.id) === p) this.outgoing.delete(peer.id)
    })
    return p
  }

  private async handshake(peer: StoredPeer): Promise<Session> {
    const seen = this.seen.get(peer.id)
    const address = seen?.address ?? peer.address
    const port = seen?.port ?? peer.port ?? LAN_PORT
    if (!address) throw new LanError(404, `不知道 ${peer.name} 在哪裡（它開著內網連線嗎？）`)
    const wire = await dial(address, port)
    try {
      const eph = newEphemeral()
      const nonce = randomBytes(16)
      wire.sendPlain({ t: 'hello', v: PROTOCOL_VERSION, id: this.state.deviceId, e: b64(eph.publicRaw), n: b64(nonce) })
      const r = await wire.next()
      if (r.t !== 'hello') throw new LanError(502, '對方的回應不正確')
      if (r.id !== peer.id) throw new LanError(502, `${address} 上現在不是 ${peer.name}`)
      const fields = {
        clientId: this.state.deviceId,
        serverId: peer.id,
        clientEph: eph.publicRaw,
        serverEph: unb64(r.e, 32),
        clientNonce: nonce,
        serverNonce: unb64(r.n, 16)
      }
      const transcript = handshakeTranscript(fields)
      const keys = sessionKeys(eph, fields.serverEph, unb64(peer.secret), transcript)
      if (!macEqual(unb64(r.mac), helloMac(keys, 'server', transcript))) {
        throw new LanError(403, `和 ${peer.name} 的配對已失效，請重新配對`)
      }
      wire.sendPlain({ t: 'auth', mac: b64(helloMac(keys, 'client', transcript)) })
      const session = new Session(peer.id, wire, keys.clientToServer, keys.serverToClient, (m, p) => this.serve(peer.id, m, p))
      this.connectedOut.add(peer.id)
      wire.onClose(() => {
        this.connectedOut.delete(peer.id)
        this.emit('changed')
      })
      this.emit('changed')
      return session
    } catch (e) {
      wire.close()
      throw e
    }
  }

  private async accept(sock: Socket): Promise<void> {
    const wire = new Wire(sock)
    try {
      const msg = await wire.next()
      if (msg.t === 'whoami') {
        wire.sendPlain({ t: 'whoami', id: this.state.deviceId, name: this.deps.deviceName(), version: this.deps.version, port: this.port })
        sock.end()
      } else if (msg.t === 'pair') {
        await this.acceptPair(wire, msg, sock.remoteAddress)
      } else if (msg.t === 'hello') {
        await this.acceptHello(wire, msg)
      } else {
        wire.refuse(400, '不認得的請求')
      }
    } catch (e) {
      if (!wire.closed) {
        const status = e instanceof LanError ? e.status : 400
        wire.refuse(status, e instanceof LanError ? e.message : '連線失敗')
      }
    }
  }

  private async acceptPair(wire: Wire, msg: Json, remoteAddress: string | undefined): Promise<void> {
    const p = this.pairing
    if (!p || Date.now() > p.expiresAt) return wire.refuse(403, '對方沒有開放配對（請在那台電腦按「顯示配對碼」）')
    p.attempts++
    if (p.attempts >= PAIR_ATTEMPTS) this.cancelPairing()
    const sid = unb64(msg.sid, 16)
    const peerShare = unb64(msg.y, 32)
    const peerId = str(msg.id, 64)
    const peerName = str(msg.name, 80) || remoteAddress || '未命名裝置'
    if (!peerId || peerId === this.state.deviceId) return wire.refuse(400, 'malformed message')
    const cp = cpaceStart(p.code, sid)
    const me = { id: this.state.deviceId, name: this.deps.deviceName() }
    const transcript = JSON.stringify([b64(sid), peerId, peerName, me.id, me.name, b64(peerShare), b64(cp.share)])
    const isk = cpaceFinish(cp, peerShare, sid, peerShare, cp.share)
    wire.sendPlain({ t: 'pair-ok', id: me.id, name: me.name, y: b64(cp.share), mac: b64(pairMac(isk, 'responder', transcript)) })
    const confirm = await wire.next(30_000)
    if (confirm.t !== 'pair-confirm' || !macEqual(unb64(confirm.mac), pairMac(isk, 'initiator', transcript))) {
      this.deps.log.warn(`lan: failed pairing attempt from ${remoteAddress}`)
      this.emit('changed')
      return wire.refuse(403, '配對碼不對')
    }
    this.cancelPairing()
    const port = Number(msg.port)
    this.savePeer({
      id: peerId,
      name: peerName,
      secret: b64(pairingSecret(isk)),
      address: remoteAddress?.replace(/^::ffff:/, ''),
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : LAN_PORT,
      allowWrite: false,
      pairedAt: Date.now()
    })
    this.deps.log.info(`lan: paired with ${peerName} (${peerId}) from ${remoteAddress}`)
    wire.sendPlain({ t: 'paired' })
    wire.sock.end()
  }

  private async acceptHello(wire: Wire, msg: Json): Promise<void> {
    const peer = this.peer(str(msg.id, 64))
    if (!peer) return wire.refuse(403, `${this.deps.deviceName()} 沒有和你配對（可能已被解除），請重新配對`)
    const eph = newEphemeral()
    const nonce = randomBytes(16)
    const fields = {
      clientId: peer.id,
      serverId: this.state.deviceId,
      clientEph: unb64(msg.e, 32),
      serverEph: eph.publicRaw,
      clientNonce: unb64(msg.n, 16),
      serverNonce: nonce
    }
    const transcript = handshakeTranscript(fields)
    const keys = sessionKeys(eph, fields.clientEph, unb64(peer.secret), transcript)
    wire.sendPlain({ t: 'hello', id: this.state.deviceId, e: b64(eph.publicRaw), n: b64(nonce), mac: b64(helloMac(keys, 'server', transcript)) })
    const auth = await wire.next()
    if (auth.t !== 'auth' || !macEqual(unb64(auth.mac), helloMac(keys, 'client', transcript))) {
      return wire.refuse(403, '配對已失效，請重新配對')
    }
    const session = new Session(peer.id, wire, keys.serverToClient, keys.clientToServer, (m, p) => this.serve(peer.id, m, p))
    this.incoming.add(session)
    wire.onClose(() => {
      this.incoming.delete(session)
      this.emit('changed')
    })
    this.emit('changed')
  }

  /** A request from a paired device, over an authenticated session. */
  private async serve(peerId: string, method: string, params: unknown): Promise<unknown> {
    const peer = this.peer(peerId)
    if (!peer) throw new LanError(403, '配對已解除')
    if (method === 'info') return { id: this.state.deviceId, name: this.deps.deviceName(), version: this.deps.version }
    if (method === 'unpair') {
      // Answer first: forgetting the peer closes this very session.
      setImmediate(() => this.forgetPeer(peerId))
      return { ok: true }
    }
    if (method === 'bridge') {
      const p = (params && typeof params === 'object' ? params : {}) as Json
      const kind = BRIDGE_KINDS.find((k) => k === p.kind)
      if (!kind) throw new LanError(400, 'unknown bridge call')
      const call: BridgeCall = {
        kind,
        id: typeof p.id === 'string' ? p.id.slice(0, 64) : undefined,
        body: p.body && typeof p.body === 'object' && !Array.isArray(p.body) ? (p.body as Json) : {},
        lines: typeof p.lines === 'number' ? p.lines : undefined
      }
      return this.deps.exec(call, { owner: peerId, allowWrite: peer.allowWrite, label: peer.name })
    }
    if (method.startsWith('sync.') && this.deps.syncServe) return this.deps.syncServe(peerId, method, params)
    throw new LanError(404, `unknown method ${method}`)
  }

  // ---- discovery ----

  private startDiscovery(): void {
    const udp = createSocket({ type: 'udp4', reuseAddr: true })
    this.udp = udp
    udp.on('error', (e) => this.deps.log.warn(`lan discovery: ${e.message}`))
    udp.on('message', (buf, rinfo) => this.onDatagram(buf, rinfo.address))
    udp.bind(DISCOVERY_PORT, () => {
      try {
        udp.setBroadcast(true)
      } catch (e) {
        this.deps.log.warn(`lan discovery: ${(e as Error).message}`)
      }
      this.broadcast('probe')
      this.broadcast('announce')
    })
    this.announceTimer = setInterval(() => this.broadcast('announce'), ANNOUNCE_MS)
  }

  private datagram(t: 'announce' | 'probe'): Buffer {
    return Buffer.from(
      JSON.stringify({ app: 'baguette', v: PROTOCOL_VERSION, t, id: this.state.deviceId, name: this.deps.deviceName(), port: this.port, version: this.deps.version })
    )
  }

  private broadcast(t: 'announce' | 'probe'): void {
    const udp = this.udp
    if (!udp) return
    const msg = this.datagram(t)
    for (const addr of broadcastAddresses()) {
      udp.send(msg, DISCOVERY_PORT, addr, (e) => e && this.deps.log.warn(`lan discovery send to ${addr}: ${e.message}`))
    }
  }

  private onDatagram(buf: Buffer, address: string): void {
    let m: Json
    try {
      m = JSON.parse(buf.toString('utf8')) as Json
    } catch {
      return
    }
    if (m.app !== 'baguette' || m.id === this.state.deviceId) return
    const id = str(m.id, 64)
    const port = Number(m.port)
    if (!id || !Number.isInteger(port) || port <= 0 || port > 65535) return
    this.noteSeen({ id, name: str(m.name, 80) || address, address, port, version: str(m.version, 20) })
    if (m.t === 'probe') this.udp?.send(this.datagram('announce'), DISCOVERY_PORT, address)
  }

  private noteSeen(s: Omit<Seen, 'lastSeen'>): void {
    const before = this.seen.get(s.id)
    this.seen.set(s.id, { ...s, lastSeen: Date.now() })
    const peer = this.peer(s.id)
    if (peer && (peer.address !== s.address || peer.port !== s.port || peer.name !== s.name)) {
      peer.address = s.address
      peer.port = s.port
      peer.name = s.name
      this.persist()
    }
    if (!before || before.address !== s.address || before.name !== s.name) this.emit('changed')
  }
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error): void => reject(e)
    server.once('error', onError)
    server.listen(port, '0.0.0.0', () => {
      server.off('error', onError)
      const addr = server.address()
      resolve(typeof addr === 'object' && addr ? addr.port : port)
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
