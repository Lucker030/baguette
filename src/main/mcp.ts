import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

// MCP server for the agent bridge, so any AI CLI (Claude Code, Codex, agy …)
// can open and talk to tabs on this PC or on a paired one, as tools.
//
// It is a separate process that the AI CLI starts over stdio, using
// baguette's own exe as a plain Node runtime:
//
//   ELECTRON_RUN_AS_NODE=1 baguette.exe <…>/app.asar.unpacked/out/main/mcp.js <userData>/agent-bridge.json
//
// (the 內網裝置 screen shows the exact command). It holds no state of its
// own: every tool call becomes one request to the running app's bridge
// (agent-bridge.ts), which relays /v1/devices/<id>/… to the paired PC. The
// bridge file is re-read on every call because the port and token change
// whenever baguette restarts.
//
// Self-contained on purpose — Node builtins only, nothing imported from the
// app — so the build emits it as one standalone file.

type Json = Record<string, unknown>

const bridgeFile = process.argv[2] || join(process.env.APPDATA ?? '', 'baguette', 'agent-bridge.json')

const PROVIDERS = ['claude', 'codex', 'copilot', 'antigravity']
const KEYS = ['enter', 'esc', 'tab', 'up', 'down', 'left', 'right', 'y', 'n', '1', '2', '3', '4', '5', '6', '7', '8', '9']

function bridge(method: string, path: string, body?: Json): Promise<Json> {
  let info: { port?: number; token?: string }
  try {
    info = JSON.parse(readFileSync(bridgeFile, 'utf8')) as { port?: number; token?: string }
  } catch {
    return Promise.reject(new Error(`baguette is not running, or its agent bridge is off (設定 → agent bridge). No ${bridgeFile}`))
  }
  const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : undefined
  return new Promise((resolve, reject) => {
    // node:http rather than fetch: a reply can take many minutes, and fetch
    // gives up on headers after five.
    const req = request(
      {
        host: '127.0.0.1',
        port: info.port,
        method,
        path,
        headers: {
          authorization: `Bearer ${info.token}`,
          'content-type': 'application/json',
          ...(data ? { 'content-length': data.length } : {})
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          let json: Json = {}
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json
          } catch {
            /* not JSON */
          }
          if ((res.statusCode ?? 500) >= 400) reject(new Error(String(json.error ?? `HTTP ${res.statusCode}`)))
          else resolve(json)
        })
      }
    )
    req.on('error', (e) => reject(new Error(`cannot reach baguette (is it running?): ${e.message}`)))
    req.end(data)
  })
}

/** `/v1` for this PC, `/v1/devices/<id>` for a paired one named by id or name. */
async function base(device: unknown): Promise<string> {
  if (typeof device !== 'string' || !device.trim() || device.trim().toLowerCase() === 'local') return '/v1'
  const want = device.trim().toLowerCase()
  const { devices } = (await bridge('GET', '/v1/devices')) as { devices?: { id: string; name: string; paired: boolean }[] }
  const paired = (devices ?? []).filter((d) => d.paired)
  const hit = paired.find((d) => d.id.toLowerCase() === want) ?? paired.find((d) => d.name.toLowerCase() === want)
  if (!hit) {
    throw new Error(`no paired device "${device}". Paired: ${paired.map((d) => d.name).join(', ') || '(none)'}`)
  }
  return `/v1/devices/${encodeURIComponent(hit.id)}`
}

function tabPath(b: string, tab: unknown): string {
  if (typeof tab !== 'string' || !/^[\w-]+$/.test(tab)) throw new Error('tab must be a tab id from baguette_open_tab or baguette_list_tabs')
  return `${b}/tabs/${tab}`
}

function seconds(v: unknown, dflt: number): number {
  return typeof v === 'number' && v > 0 ? Math.round(v * 1000) : dflt
}

const DEVICE = {
  device: {
    type: 'string',
    description: 'Which PC: the name or id of a paired device (see baguette_devices). Omit for this PC.'
  }
}
const TAB = { tab: { type: 'string', description: 'Tab id, from baguette_open_tab or baguette_list_tabs.' } }

const TOOLS = [
  {
    name: 'baguette_devices',
    description:
      "List the PCs this baguette is paired with on the LAN and whether each is online. Pass a device's name as `device` to the other tools to act on that PC.",
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'baguette_list_tabs',
    description: 'List the agent tabs you opened through baguette on a PC.',
    inputSchema: { type: 'object', properties: { ...DEVICE } }
  },
  {
    name: 'baguette_open_tab',
    description:
      'Open an AI CLI as a visible tab in baguette (on this PC or a paired one) and wait until it is ready. Returns the tab id. Tabs are read-only (the agent can answer but not edit files or run commands) unless readOnly is false — a paired PC only allows that if its owner turned it on.',
    inputSchema: {
      type: 'object',
      properties: {
        ...DEVICE,
        provider: { type: 'string', enum: PROVIDERS, description: 'Which CLI to start.' },
        name: { type: 'string', description: 'Tab name.' },
        cwd: { type: 'string', description: 'Working directory on that PC.' },
        readOnly: { type: 'boolean', description: 'Default true.' }
      },
      required: ['provider']
    }
  },
  {
    name: 'baguette_send',
    description:
      "Send a message to a tab (pasted, then Enter) and wait for the agent to finish; returns its reply. Messages may not start with ! or /. If the reply looks cut off or the agent stopped at a question, use baguette_screen, then baguette_key or baguette_wait.",
    inputSchema: {
      type: 'object',
      properties: {
        ...DEVICE,
        ...TAB,
        text: { type: 'string' },
        timeoutSeconds: { type: 'number', description: 'Give up waiting after this long (default 600).' }
      },
      required: ['tab', 'text']
    }
  },
  {
    name: 'baguette_key',
    description: 'Press one key in a tab — to answer a prompt such as "1. Yes / 2. No" or a trust dialog. Returns the screen after.',
    inputSchema: {
      type: 'object',
      properties: { ...DEVICE, ...TAB, key: { type: 'string', enum: KEYS } },
      required: ['tab', 'key']
    }
  },
  {
    name: 'baguette_screen',
    description: "Read what a tab's terminal shows right now.",
    inputSchema: {
      type: 'object',
      properties: { ...DEVICE, ...TAB, lines: { type: 'number', description: 'How many lines (default 60).' } },
      required: ['tab']
    }
  },
  {
    name: 'baguette_wait',
    description: 'Wait until a tab stops producing output, then return its screen.',
    inputSchema: {
      type: 'object',
      properties: { ...DEVICE, ...TAB, timeoutSeconds: { type: 'number' } },
      required: ['tab']
    }
  },
  {
    name: 'baguette_close_tab',
    description: 'Close a tab you opened.',
    inputSchema: { type: 'object', properties: { ...DEVICE, ...TAB }, required: ['tab'] }
  }
]

// MCP tool annotations. Clients use them to decide what needs the user's
// approval: Codex refuses an unannotated tool outright when its approval
// policy is "never" (seen 2026-10-25), so the tools that only read say so.
// The others act (open a tab, type, close one), though never on files: a
// bridge tab is read-only unless that PC allowed otherwise.
const READ_ONLY = new Set(['baguette_devices', 'baguette_list_tabs', 'baguette_screen', 'baguette_wait'])
for (const t of TOOLS as (typeof TOOLS[number] & { annotations?: Json })[]) {
  t.annotations = READ_ONLY.has(t.name)
    ? { readOnlyHint: true, openWorldHint: false }
    : { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
}

async function callTool(name: string, a: Json): Promise<string> {
  switch (name) {
    case 'baguette_devices': {
      const { devices } = (await bridge('GET', '/v1/devices')) as { devices?: Json[] }
      const paired = (devices ?? []).filter((d) => d.paired)
      if (!paired.length) return 'No paired devices. Pair one in baguette → 內網裝置.'
      return paired.map((d) => `${d.name}  (${d.online ? 'online' : 'offline'}${d.address ? `, ${d.address}` : ''}, id ${d.id})`).join('\n')
    }
    case 'baguette_list_tabs':
      return JSON.stringify(await bridge('GET', `${await base(a.device)}/tabs`), null, 2)
    case 'baguette_open_tab': {
      const r = await bridge('POST', `${await base(a.device)}/tabs`, {
        provider: a.provider,
        name: a.name,
        cwd: a.cwd,
        readOnly: a.readOnly !== false
      })
      return JSON.stringify(r, null, 2)
    }
    case 'baguette_send': {
      const r = await bridge('POST', `${tabPath(await base(a.device), a.tab)}/input`, {
        text: a.text,
        timeoutMs: seconds(a.timeoutSeconds, 600_000)
      })
      const head = r.settled === false ? '[still working — check again with baguette_wait]\n' : ''
      return head + String(r.reply ?? '')
    }
    case 'baguette_key': {
      const r = await bridge('POST', `${tabPath(await base(a.device), a.tab)}/input`, { key: a.key })
      return String(r.screen ?? '')
    }
    case 'baguette_screen': {
      const lines = typeof a.lines === 'number' ? Math.round(a.lines) : 60
      const r = await bridge('GET', `${tabPath(await base(a.device), a.tab)}/screen?lines=${lines}`)
      return String(r.screen ?? '')
    }
    case 'baguette_wait': {
      const r = await bridge('POST', `${tabPath(await base(a.device), a.tab)}/wait`, { timeoutMs: seconds(a.timeoutSeconds, 600_000) })
      return (r.settled === false ? '[still working]\n' : '') + String(r.screen ?? '')
    }
    case 'baguette_close_tab':
      await bridge('DELETE', tabPath(await base(a.device), a.tab))
      return 'closed'
  }
  throw new Error(`unknown tool ${name}`)
}

// ---- JSON-RPC over stdio (one message per line) ----

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

function reply(msg: Json): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
}

async function handle(msg: Json): Promise<void> {
  const { id, method } = msg
  const params = (msg.params ?? {}) as Json
  const isRequest = id !== undefined && id !== null
  try {
    switch (method) {
      case 'initialize': {
        const asked = String(params.protocolVersion ?? '')
        return reply({
          id,
          result: {
            protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
            capabilities: { tools: {} },
            serverInfo: { name: 'baguette', version: '1' },
            instructions:
              'Drive AI CLI tabs in baguette on this PC or on paired LAN PCs: baguette_devices → baguette_open_tab → baguette_send.'
          }
        })
      }
      case 'ping':
        return reply({ id, result: {} })
      case 'tools/list':
        return reply({ id, result: { tools: TOOLS } })
      case 'tools/call': {
        const name = String(params.name ?? '')
        const args = (params.arguments ?? {}) as Json
        try {
          const text = await callTool(name, args)
          return reply({ id, result: { content: [{ type: 'text', text }] } })
        } catch (e) {
          // A failed tool is a result the model reads, not a protocol error.
          return reply({ id, result: { content: [{ type: 'text', text: (e as Error).message }], isError: true } })
        }
      }
      default:
        if (isRequest) reply({ id, error: { code: -32601, message: `method not found: ${String(method)}` } })
    }
  } catch (e) {
    if (isRequest) reply({ id, error: { code: -32603, message: (e as Error).message } })
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  let msg: Json
  try {
    msg = JSON.parse(line) as Json
  } catch {
    return reply({ id: null, error: { code: -32700, message: 'parse error' } })
  }
  void handle(msg)
})
