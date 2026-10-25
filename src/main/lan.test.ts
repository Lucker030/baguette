import { afterEach, describe, expect, it } from 'vitest'
import type { BridgeCall, Caller } from './agent-bridge'
import { LanNode, broadcastAddresses, parseAddress, type LanState } from './lan'

// Two real nodes talking over 127.0.0.1 (discovery off, random ports): the
// rules pinned here are the ones whose failure would let the wrong machine in
// or lock the right one out.

const quiet = { info: () => {}, warn: () => {} }

interface TestNode {
  node: LanNode
  state: () => LanState
  calls: { call: BridgeCall; caller: Caller }[]
  addr: () => string
}

const nodes: LanNode[] = []

async function makeNode(id: string, name: string): Promise<TestNode> {
  let state: LanState = { deviceId: id, peers: [] }
  const calls: TestNode['calls'] = []
  const node = new LanNode({
    store: { load: () => state, save: (s) => (state = JSON.parse(JSON.stringify(s)) as LanState) },
    deviceName: () => name,
    version: 'test',
    exec: async (call, caller) => {
      calls.push({ call, caller })
      if (call.kind === 'screen') throw Object.assign(new Error('no such tab'), { status: 404 })
      return { ok: true, kind: call.kind }
    },
    log: quiet,
    port: 0,
    discovery: false
  })
  nodes.push(node)
  await node.start()
  return { node, state: () => state, calls, addr: () => `127.0.0.1:${node.status().port}` }
}

async function paired(): Promise<{ a: TestNode; b: TestNode }> {
  const a = await makeNode('id-a', 'PC-A')
  const b = await makeNode('id-b', 'PC-B')
  const { code } = b.node.startPairing()
  await a.node.pair({ address: b.addr() }, code)
  return { a, b }
}

afterEach(() => {
  for (const n of nodes.splice(0)) n.stop()
})

describe('pairing', () => {
  it('stores each side on the other with the same secret, and withdraws the code', async () => {
    const { a, b } = await paired()
    const pa = a.state().peers
    const pb = b.state().peers
    expect(pa.map((p) => [p.id, p.name])).toEqual([['id-b', 'PC-B']])
    expect(pb.map((p) => [p.id, p.name])).toEqual([['id-a', 'PC-A']])
    expect(pa[0].secret).toBe(pb[0].secret)
    expect(pb[0].allowWrite).toBe(false)
    expect(b.node.status().pairing).toBeNull()
  })

  it('refuses a wrong code without pairing either side', async () => {
    const a = await makeNode('id-a', 'PC-A')
    const b = await makeNode('id-b', 'PC-B')
    const { code } = b.node.startPairing()
    const wrong = code === '000000' ? '000001' : '000000'
    await expect(a.node.pair({ address: b.addr() }, wrong)).rejects.toThrow(/配對碼不對/)
    expect(a.state().peers).toEqual([])
    expect(b.state().peers).toEqual([])
  })

  it('withdraws the code after three attempts, even the right one then fails', async () => {
    const a = await makeNode('id-a', 'PC-A')
    const b = await makeNode('id-b', 'PC-B')
    const { code } = b.node.startPairing()
    const wrong = code === '000000' ? '000001' : '000000'
    for (let i = 0; i < 3; i++) await expect(a.node.pair({ address: b.addr() }, wrong)).rejects.toThrow()
    expect(b.node.status().pairing).toBeNull()
    await expect(a.node.pair({ address: b.addr() }, code)).rejects.toThrow(/沒有開放配對/)
  })

  it('refuses when the target is not showing a code', async () => {
    const a = await makeNode('id-a', 'PC-A')
    const b = await makeNode('id-b', 'PC-B')
    await expect(a.node.pair({ address: b.addr() }, '123456')).rejects.toThrow(/沒有開放配對/)
  })
})

describe('calls between paired PCs', () => {
  it('reach the other bridge as that device, read-only unless allowed', async () => {
    const { a, b } = await paired()
    await expect(a.node.call('id-b', { kind: 'list', body: {} })).resolves.toEqual({ ok: true, kind: 'list' })
    expect(b.calls[0].caller).toEqual({ owner: 'id-a', allowWrite: false, label: 'PC-A' })

    b.node.setAllowWrite('id-a', true)
    await a.node.call('PC-B', { kind: 'open', body: { provider: 'claude' } }) // by name works too
    expect(b.calls[1].caller.allowWrite).toBe(true)
    expect(b.calls[1].call).toEqual({ kind: 'open', id: undefined, body: { provider: 'claude' }, lines: undefined })
  })

  it('carries the other side\'s error status back', async () => {
    const { a } = await paired()
    await expect(a.node.call('id-b', { kind: 'screen', id: 'x', body: {} })).rejects.toMatchObject({ status: 404 })
  })

  it('is refused once the target forgot the pairing', async () => {
    const { a, b } = await paired()
    // B comes back without the pairing, without telling A (lan.json reset).
    const b2 = new LanNode({
      store: { load: () => ({ deviceId: 'id-b', peers: [] }), save: () => {} },
      deviceName: () => 'PC-B',
      version: 'test',
      exec: async () => ({}),
      log: quiet,
      port: Number(b.node.status().port),
      discovery: false
    })
    b.node.stop()
    nodes.push(b2)
    await b2.start()
    await expect(a.node.call('id-b', { kind: 'list', body: {} })).rejects.toThrow(/沒有和你配對/)
  })

  it('unpairing on one side removes the pairing on both', async () => {
    const { a, b } = await paired()
    await a.node.unpair('id-b')
    expect(a.state().peers).toEqual([])
    await new Promise((r) => setTimeout(r, 50))
    expect(b.state().peers).toEqual([])
  })

  it('a stranger with a made-up secret gets nothing', async () => {
    const { b } = await paired()
    // Claims A's id, but never saw the pairing.
    const fake = new LanNode({
      store: {
        load: () => ({
          deviceId: 'id-a',
          peers: [{ id: 'id-b', name: 'PC-B', secret: Buffer.alloc(32, 7).toString('base64'), address: '127.0.0.1', port: b.node.status().port, allowWrite: false, pairedAt: 0 }]
        }),
        save: () => {}
      },
      deviceName: () => 'PC-A',
      version: 'test',
      exec: async () => ({}),
      log: quiet,
      port: 0,
      discovery: false
    })
    nodes.push(fake)
    await fake.start()
    await expect(fake.call('id-b', { kind: 'list', body: {} })).rejects.toThrow(/配對已失效/)
    expect(b.calls).toEqual([])
  })
})

describe('probe', () => {
  it('finds a device by address and lists it as nearby', async () => {
    const a = await makeNode('id-a', 'PC-A')
    const b = await makeNode('id-b', 'PC-B')
    const d = await a.node.probe(b.addr())
    expect(d).toMatchObject({ id: 'id-b', name: 'PC-B', paired: false, online: true })
  })
})

describe('parseAddress', () => {
  it('takes an IPv4 with an optional port', () => {
    expect(parseAddress('192.168.0.124')).toEqual({ address: '192.168.0.124', port: 47610 })
    expect(parseAddress(' 10.0.0.2:5000 ')).toEqual({ address: '10.0.0.2', port: 5000 })
    expect(parseAddress('300.1.1.1')).toBeNull()
    expect(parseAddress('pc.local')).toBeNull()
  })
})

describe('broadcastAddresses', () => {
  it('computes each interface\'s directed broadcast', () => {
    const out = broadcastAddresses({
      eth: [{ family: 'IPv4', internal: false, address: '192.168.0.124', netmask: '255.255.255.0' } as never],
      lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0' } as never]
    })
    expect(out.sort()).toEqual(['192.168.0.255', '255.255.255.255'])
  })
})
