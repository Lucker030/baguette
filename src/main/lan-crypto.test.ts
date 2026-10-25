import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  FrameCipher,
  FrameReader,
  cpaceFinish,
  cpaceStart,
  encodeFrame,
  handshakeTranscript,
  helloMac,
  newEphemeral,
  newPairingCode,
  pairMac,
  sessionKeys
} from './lan-crypto'

function pairWith(codeA: string, codeB: string): { a: Buffer; b: Buffer } {
  const sid = randomBytes(16)
  const A = cpaceStart(codeA, sid)
  const B = cpaceStart(codeB, sid)
  return {
    a: cpaceFinish(A, B.share, sid, A.share, B.share),
    b: cpaceFinish(B, A.share, sid, A.share, B.share)
  }
}

describe('pairing (CPace)', () => {
  it('gives both sides the same key for the same code', () => {
    const { a, b } = pairWith('123456', '123456')
    expect(a.equals(b)).toBe(true)
  })

  it('gives different keys for a wrong code, so the confirmation MACs differ', () => {
    const { a, b } = pairWith('123456', '123457')
    expect(a.equals(b)).toBe(false)
    expect(pairMac(a, 'responder', 't').equals(pairMac(b, 'responder', 't'))).toBe(false)
  })

  it('never sends anything that depends on the code alone', () => {
    // Two runs with the same code and session id still produce unrelated shares.
    const sid = randomBytes(16)
    expect(Buffer.from(cpaceStart('000000', sid).share).equals(Buffer.from(cpaceStart('000000', sid).share))).toBe(false)
  })

  it('rejects an invalid share', () => {
    const sid = randomBytes(16)
    const A = cpaceStart('111111', sid)
    expect(() => cpaceFinish(A, new Uint8Array(32).fill(0xff), sid, A.share, A.share)).toThrow()
  })

  it('codes are six digits', () => {
    for (let i = 0; i < 50; i++) expect(newPairingCode()).toMatch(/^\d{6}$/)
  })
})

describe('session handshake', () => {
  const fields = (c: Buffer, s: Buffer) => ({
    clientId: 'c',
    serverId: 's',
    clientEph: c,
    serverEph: s,
    clientNonce: Buffer.alloc(16, 1),
    serverNonce: Buffer.alloc(16, 2)
  })

  it('derives the same keys on both sides only with the same pairing secret', () => {
    const c = newEphemeral()
    const s = newEphemeral()
    const t = handshakeTranscript(fields(c.publicRaw, s.publicRaw))
    const secret = randomBytes(32)
    const kc = sessionKeys(c, s.publicRaw, secret, t)
    const ks = sessionKeys(s, c.publicRaw, secret, t)
    expect(kc.clientToServer.equals(ks.clientToServer)).toBe(true)
    expect(helloMac(kc, 'server', t).equals(helloMac(ks, 'server', t))).toBe(true)
    const wrong = sessionKeys(s, c.publicRaw, randomBytes(32), t)
    expect(helloMac(kc, 'server', t).equals(helloMac(wrong, 'server', t))).toBe(false)
  })
})

describe('FrameCipher', () => {
  it('round-trips, and rejects tampered, replayed or reordered frames', () => {
    const key = randomBytes(32)
    const tx = new FrameCipher(key)
    const f1 = tx.seal(Buffer.from('one'))
    const f2 = tx.seal(Buffer.from('two'))

    const rx = new FrameCipher(key)
    expect(rx.open(f1).toString()).toBe('one')
    expect(() => rx.open(f1)).toThrow() // replay: the counter has moved on

    const tampered = Buffer.from(f2)
    tampered[0] ^= 1
    expect(() => new FrameCipher(key).open(tampered)).toThrow()
    expect(() => new FrameCipher(key).open(f2)).toThrow() // out of order
  })
})

describe('FrameReader', () => {
  it('reassembles frames split and merged across chunks', () => {
    const r = new FrameReader()
    const all = Buffer.concat([encodeFrame(Buffer.from('hello')), encodeFrame(Buffer.from('world'))])
    expect(r.push(all.subarray(0, 3))).toEqual([])
    const out = r.push(all.subarray(3))
    expect(out.map((b) => b.toString())).toEqual(['hello', 'world'])
  })

  it('refuses an absurd length', () => {
    const r = new FrameReader()
    const len = Buffer.alloc(4)
    len.writeUInt32BE(0xffffffff)
    expect(() => r.push(len)).toThrow()
  })
})
