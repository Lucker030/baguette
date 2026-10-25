import { app, safeStorage } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeFileAtomic } from './atomic-write'
import { log } from './log'
import type { LanState, LanStore, StoredPeer } from './lan'

// This PC's LAN identity and its paired devices, in userData/lan.json.
// Pairing secrets are encrypted by the OS (safeStorage: DPAPI on Windows,
// tied to this Windows user), so a copy of the file is no use elsewhere.
// Where that isn't available they are stored as plain base64, marked so.

interface StoredSecret {
  enc: 'os' | 'plain'
  data: string
}

function lanFile(): string {
  return join(app.getPath('userData'), 'lan.json')
}

function sealSecret(secret: string): StoredSecret {
  if (safeStorage.isEncryptionAvailable()) {
    return { enc: 'os', data: safeStorage.encryptString(secret).toString('base64') }
  }
  return { enc: 'plain', data: secret }
}

function openSecret(s: unknown): string | null {
  if (!s || typeof s !== 'object') return null
  const { enc, data } = s as Partial<StoredSecret>
  if (typeof data !== 'string') return null
  if (enc === 'plain') return data
  try {
    return safeStorage.decryptString(Buffer.from(data, 'base64'))
  } catch {
    return null
  }
}

function readPeer(v: unknown): StoredPeer | null {
  if (!v || typeof v !== 'object') return null
  const p = v as Record<string, unknown>
  const secret = openSecret(p.secret)
  if (typeof p.id !== 'string' || !p.id || !secret) return null
  return {
    id: p.id,
    name: typeof p.name === 'string' ? p.name : p.id,
    secret,
    address: typeof p.address === 'string' ? p.address : undefined,
    port: typeof p.port === 'number' ? p.port : undefined,
    allowWrite: p.allowWrite === true,
    pairedAt: typeof p.pairedAt === 'number' ? p.pairedAt : 0
  }
}

function save(state: LanState): void {
  const out = {
    version: 1,
    deviceId: state.deviceId,
    peers: state.peers.map((p) => ({ ...p, secret: sealSecret(p.secret) }))
  }
  try {
    writeFileAtomic(lanFile(), JSON.stringify(out, null, 2))
  } catch (e) {
    log.error(`lan: could not save ${lanFile()}: ${(e as Error).message}`)
  }
}

export const lanStore: LanStore = {
  load(): LanState {
    let raw: Record<string, unknown> = {}
    try {
      raw = JSON.parse(readFileSync(lanFile(), 'utf8')) as Record<string, unknown>
    } catch {
      /* first run */
    }
    const peers = Array.isArray(raw.peers) ? raw.peers.map(readPeer).filter((p): p is StoredPeer => p !== null) : []
    const dropped = Array.isArray(raw.peers) ? raw.peers.length - peers.length : 0
    if (dropped) log.warn(`lan: dropped ${dropped} pairing(s) whose secret could not be read`)
    const state = { deviceId: typeof raw.deviceId === 'string' && raw.deviceId ? raw.deviceId : randomUUID(), peers }
    // Persist a new id at once, so this PC keeps the same identity.
    if (state.deviceId !== raw.deviceId || dropped) save(state)
    return state
  },
  save
}
