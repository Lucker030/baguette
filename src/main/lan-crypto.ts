import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomInt,
  timingSafeEqual,
  type KeyObject
} from 'node:crypto'
import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519'

// The cryptography behind LAN control (lan.ts), kept free of sockets and
// Electron so every piece can be tested directly.
//
// Pairing: the 6-digit code is the password of a PAKE (CPace over
// ristretto255). A plain "prove you know the code" MAC would not do: anyone
// who sees one exchange on the LAN could try all 10^6 codes offline in well
// under a second. With CPace, an eavesdropper learns nothing about the code
// and an active attacker gets one guess per attempt, which the target
// limits (see lan.ts PAIR_ATTEMPTS).
//
// After pairing, both sides keep a 32-byte pairing secret. Every connection
// mixes it with a fresh X25519 exchange, so a session key is only ever known
// to the two paired devices, and a leaked secret doesn't expose sessions
// recorded earlier. Frames are then AES-256-GCM, hardware-accelerated and far
// faster than the LAN itself.

const PROTOCOL = 'baguette-lan-v1'

/** ristretto255's prime group order. */
const ORDER = 2n ** 252n + 27742317777372353535851937790883648493n

export function newPairingCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

/** Length-prefixed concatenation, so field boundaries can't be shifted. */
function lv(...parts: (Uint8Array | string)[]): Buffer {
  const out: Buffer[] = []
  for (const p of parts) {
    const b = typeof p === 'string' ? Buffer.from(p, 'utf8') : Buffer.from(p)
    const len = Buffer.alloc(4)
    len.writeUInt32BE(b.length)
    out.push(len, b)
  }
  return Buffer.concat(out)
}

function sha256(...parts: (Uint8Array | string)[]): Buffer {
  return createHash('sha256').update(lv(...parts)).digest()
}

function randomScalar(): bigint {
  // 64 bytes reduced mod the order: bias far below anything measurable.
  const n = BigInt('0x' + randomBytes(64).toString('hex')) % ORDER
  return n === 0n ? 1n : n
}

type Point = InstanceType<typeof ristretto255.Point>

export interface CpaceState {
  scalar: bigint
  /** Our public share, sent to the other side. */
  share: Uint8Array
}

/** The generator both sides derive from the code and the session id. */
function generator(code: string, sid: Uint8Array): Point {
  return ristretto255_hasher.hashToCurve(lv(PROTOCOL, 'cpace-generator', code, sid), {
    DST: `${PROTOCOL}-cpace`
  }) as Point
}

export function cpaceStart(code: string, sid: Uint8Array): CpaceState {
  const scalar = randomScalar()
  return { scalar, share: generator(code, sid).multiply(scalar).toBytes() }
}

/**
 * The shared key both sides get when they used the same code. A wrong code
 * gives a different key, which the confirmation MACs (pairMac) then catch.
 */
export function cpaceFinish(
  state: CpaceState,
  peerShare: Uint8Array,
  sid: Uint8Array,
  initiatorShare: Uint8Array,
  responderShare: Uint8Array
): Buffer {
  const peer = ristretto255.Point.fromBytes(peerShare) // throws on an invalid encoding
  const k = peer.multiply(state.scalar)
  if (k.equals(ristretto255.Point.ZERO)) throw new Error('invalid pairing share')
  return sha256(PROTOCOL, 'cpace-isk', sid, k.toBytes(), initiatorShare, responderShare)
}

/** Key confirmation for pairing: `role` keeps one side's MAC from being replayed as the other's. */
export function pairMac(isk: Uint8Array, role: 'initiator' | 'responder', transcript: string): Buffer {
  return createHmac('sha256', isk).update(lv(PROTOCOL, 'pair-confirm', role, transcript)).digest()
}

/** The long-term secret both sides store once pairing succeeded. */
export function pairingSecret(isk: Uint8Array): Buffer {
  return Buffer.from(hkdfSync('sha256', isk, Buffer.alloc(0), `${PROTOCOL} pairing-secret`, 32))
}

export function macEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

// ---- per-connection handshake ----

export interface Ephemeral {
  privateKey: KeyObject
  /** Raw 32-byte X25519 public key. */
  publicRaw: Buffer
}

export function newEphemeral(): Ephemeral {
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  const jwk = publicKey.export({ format: 'jwk' })
  return { privateKey, publicRaw: Buffer.from(jwk.x ?? '', 'base64url') }
}

function x25519(own: KeyObject, peerRaw: Uint8Array): Buffer {
  if (peerRaw.length !== 32) throw new Error('invalid key share')
  const peer = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(peerRaw).toString('base64url') }, format: 'jwk' })
  return diffieHellman({ privateKey: own, publicKey: peer })
}

export interface HandshakeFields {
  clientId: string
  serverId: string
  clientEph: Uint8Array
  serverEph: Uint8Array
  clientNonce: Uint8Array
  serverNonce: Uint8Array
}

export interface SessionKeys {
  clientToServer: Buffer
  serverToClient: Buffer
  /** Proves to the other side we hold the pairing secret. */
  confirm: Buffer
}

export function handshakeTranscript(f: HandshakeFields): Buffer {
  return sha256(PROTOCOL, 'hello', f.clientId, f.serverId, f.clientEph, f.serverEph, f.clientNonce, f.serverNonce)
}

export function sessionKeys(own: Ephemeral, peerEph: Uint8Array, secret: Uint8Array, transcript: Uint8Array): SessionKeys {
  const shared = x25519(own.privateKey, peerEph)
  const okm = Buffer.from(hkdfSync('sha256', shared, secret, Buffer.concat([Buffer.from(PROTOCOL), transcript]), 96))
  return { clientToServer: okm.subarray(0, 32), serverToClient: okm.subarray(32, 64), confirm: okm.subarray(64, 96) }
}

export function helloMac(keys: SessionKeys, role: 'client' | 'server', transcript: Uint8Array): Buffer {
  return createHmac('sha256', keys.confirm).update(lv(PROTOCOL, 'hello-confirm', role, transcript)).digest()
}

// ---- frames ----

/**
 * One direction of an encrypted channel. Each direction has its own key, and
 * the nonce is a counter, so no (key, nonce) pair is ever used twice; a
 * dropped, replayed or reordered frame fails to decrypt and kills the
 * connection.
 */
export class FrameCipher {
  private counter = 0n

  constructor(private readonly key: Buffer) {}

  private nonce(): Buffer {
    const n = Buffer.alloc(12)
    n.writeBigUInt64BE(this.counter, 4)
    this.counter++
    return n
  }

  seal(plain: Buffer): Buffer {
    const c = createCipheriv('aes-256-gcm', this.key, this.nonce())
    const body = Buffer.concat([c.update(plain), c.final()])
    return Buffer.concat([body, c.getAuthTag()])
  }

  open(sealed: Buffer): Buffer {
    if (sealed.length < 16) throw new Error('frame too short')
    const d = createDecipheriv('aes-256-gcm', this.key, this.nonce())
    d.setAuthTag(sealed.subarray(sealed.length - 16))
    return Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()])
  }
}

/**
 * Largest frame either side accepts. A skill may be 5MB (lan-sync-adapters.ts
 * SKILL_LIMITS), base64 inside JSON adds a third: well under this, with room.
 */
export const MAX_FRAME = 32 * 1024 * 1024

/** A 4-byte big-endian length, then the payload. */
export function encodeFrame(payload: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(payload.length)
  return Buffer.concat([len, payload])
}

/** Splits a byte stream back into frames; throws on a frame over MAX_FRAME. */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    const out: Buffer[] = []
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0)
      if (len > MAX_FRAME) throw new Error('frame too large')
      if (this.buf.length < 4 + len) break
      out.push(this.buf.subarray(4, 4 + len))
      this.buf = this.buf.subarray(4 + len)
    }
    return out
  }
}
