import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import type { SessionInfo } from '../shared/types'
import {
  AgentBridge,
  KEYS,
  LOCAL_CALLER,
  dropInputBox,
  isCommandLine,
  parseRoute,
  pasteSequence,
  replyAfter,
  tidyLines,
  type OpenTabRequest
} from './agent-bridge'

/** A bridge over a fake pty whose tabs print a banner and go quiet. */
function makeBridge(): { bridge: AgentBridge; opened: OpenTabRequest[] } {
  const pty = Object.assign(new EventEmitter(), {
    write: () => {},
    list: (): SessionInfo[] => [],
    backlogOf: () => 'banner\r\n',
    sizeOf: () => ({ cols: 80, rows: 24 })
  })
  const opened: OpenTabRequest[] = []
  const bridge = new AgentBridge({
    pty,
    openTab: async (req) => {
      opened.push(req)
      return `s${opened.length}`
    },
    closeTab: () => {},
    infoFile: ''
  })
  return { bridge, opened }
}

describe('AgentBridge.exec callers', () => {
  const remote = { owner: 'pc-a', allowWrite: false, label: 'PC-A' }

  it("keeps a paired PC to its own tabs, while this PC sees all", async () => {
    const { bridge } = makeBridge()
    await bridge.exec({ kind: 'open', body: { provider: 'claude' } }, LOCAL_CALLER)
    await bridge.exec({ kind: 'open', body: { provider: 'codex' } }, remote)
    const mine = (await bridge.exec({ kind: 'list', body: {} }, remote)) as { tabs: { id: string }[] }
    expect(mine.tabs.map((t) => t.id)).toEqual(['s2'])
    const all = (await bridge.exec({ kind: 'list', body: {} }, LOCAL_CALLER)) as { tabs: unknown[] }
    expect(all.tabs).toHaveLength(2)
    await expect(bridge.exec({ kind: 'screen', id: 's1', body: {} }, remote)).rejects.toMatchObject({ status: 404 })
  }, 10_000)

  it('gives a paired PC read-only tabs named after it, and writable ones only when allowed', async () => {
    const { bridge, opened } = makeBridge()
    await expect(bridge.exec({ kind: 'open', body: { provider: 'claude', readOnly: false } }, remote)).rejects.toMatchObject({
      status: 403
    })
    expect(opened).toEqual([])
    await bridge.exec({ kind: 'open', body: { provider: 'claude', name: 'x' } }, remote)
    expect(opened[0]).toMatchObject({ name: 'PC-A／x', readOnly: true })
    await bridge.exec({ kind: 'open', body: { provider: 'claude', readOnly: false } }, { ...remote, allowWrite: true })
    expect(opened[1].readOnly).toBe(false)
  }, 10_000)
})

describe('KEYS', () => {
  it('can pick any numbered option 1–9', () => {
    for (let n = 1; n <= 9; n++) expect(KEYS[String(n)]).toBe(String(n))
  })
})

describe('pasteSequence', () => {
  it('wraps text in bracketed-paste markers and submits separately', () => {
    expect(pasteSequence('hi')).toEqual({ paste: '\x1b[200~hi\x1b[201~', submit: '\r' })
  })

  it('normalizes CRLF and strips paste markers smuggled into the text', () => {
    const { paste } = pasteSequence('a\r\nb\x1b[201~c')
    expect(paste).toBe('\x1b[200~a\nbc\x1b[201~')
  })
})

describe('isCommandLine', () => {
  it('flags shell and slash commands, even indented', () => {
    expect(isCommandLine('! Set-Content hacked.txt hi')).toBe(true)
    expect(isCommandLine('  /permissions')).toBe(true)
    expect(isCommandLine('\n!rm x')).toBe(true)
  })

  it('lets ordinary messages through, including ones that mention ! or /', () => {
    expect(isCommandLine('解釋 TCP！')).toBe(false)
    expect(isCommandLine('路徑是 C:/x，用 /init 會怎樣？')).toBe(false)
  })
})

describe('tidyLines', () => {
  it('right-trims lines and drops trailing blanks', () => {
    expect(tidyLines(['a  ', ' b', '', '   '])).toEqual(['a', ' b'])
  })
})

describe('replyAfter', () => {
  it('returns what follows the echo of the message', () => {
    expect(replyAfter(['> 解釋 TCP', 'TCP 是…', '它會重送', '', ''], '解釋 TCP')).toBe('TCP 是…\n它會重送')
  })

  it('ends a multi-line echo at the message\'s last line, even when wrapped and indented', () => {
    const lines = ['> 第一行', '  第二行', '  第三行', '回答：好']
    expect(replyAfter(lines, '第一行\n第二行\n第三行\n')).toBe('回答：好')
  })

  it('is not fooled by an answer that quotes the message', () => {
    const lines = ['> 再一題', '回答：你說了「再一題」', '>']
    expect(replyAfter(lines, '再一題')).toBe('回答：你說了「再一題」')
  })

  it('skips earlier screen text above the echo (Codex inserts above its input box)', () => {
    const lines = ['  >_ OpenAI Codex', '› 上一題', '舊回答', '› 這一題', '', '• 新回答', '', '› Ask Codex to do anything', '', '  gpt · dir']
    expect(replyAfter(lines, '這一題')).toBe('• 新回答')
  })
})

describe('dropInputBox', () => {
  it('cuts the framed prompt and status line under the answer', () => {
    const lines = ['答案', '───', '>', '───', '? for shortcuts   plan · Gemini']
    expect(dropInputBox(lines)).toEqual(['答案'])
  })

  it('keeps a quote inside the answer that more text follows', () => {
    const lines = ['> 引用', '說明', '───', '❯ ', '───']
    expect(dropInputBox(lines)).toEqual(['> 引用', '說明'])
  })

  it('leaves lines alone when there is no prompt', () => {
    expect(dropInputBox(['a', 'b'])).toEqual(['a', 'b'])
  })

  it('collapses the unfilled screen rows between the answer and the status line', () => {
    const lines = ['> 問', '● 答', '', '', '', '', '   Update available!', '───', '❯', '───']
    expect(replyAfter(lines, '問')).toBe('● 答\n\n   Update available!')
  })

  it('returns everything when the echo is not found', () => {
    expect(replyAfter(['x', 'y'], 'not there')).toBe('x\ny')
  })
})

describe('parseRoute', () => {
  it('maps every endpoint', () => {
    expect(parseRoute('GET', '/v1/tabs')).toEqual({ kind: 'list' })
    expect(parseRoute('POST', '/v1/tabs')).toEqual({ kind: 'open' })
    expect(parseRoute('POST', '/v1/tabs/s1/input')).toEqual({ kind: 'input', id: 's1' })
    expect(parseRoute('GET', '/v1/tabs/s1/screen')).toEqual({ kind: 'screen', id: 's1' })
    expect(parseRoute('POST', '/v1/tabs/s1/wait')).toEqual({ kind: 'wait', id: 's1' })
    expect(parseRoute('DELETE', '/v1/tabs/s1')).toEqual({ kind: 'close', id: 's1' })
  })

  it('maps the same endpoints on a paired device, and the LAN ones', () => {
    expect(parseRoute('GET', '/v1/devices')).toEqual({ kind: 'devices' })
    expect(parseRoute('GET', '/v1/devices/abc-1/tabs')).toEqual({ kind: 'list', device: 'abc-1' })
    expect(parseRoute('POST', '/v1/devices/abc-1/tabs/s1/input')).toEqual({ kind: 'input', id: 's1', device: 'abc-1' })
    expect(parseRoute('POST', '/v1/lan/pairing')).toEqual({ kind: 'pairing-start' })
    expect(parseRoute('DELETE', '/v1/lan/pairing')).toEqual({ kind: 'pairing-stop' })
    expect(parseRoute('POST', '/v1/lan/pair')).toEqual({ kind: 'pair' })
    expect(parseRoute('GET', '/v1/devices/../tabs')).toBeNull()
  })

  it('rejects wrong methods and unknown paths', () => {
    expect(parseRoute('DELETE', '/v1/tabs')).toBeNull()
    expect(parseRoute('GET', '/v1/tabs/s1/input')).toBeNull()
    expect(parseRoute('POST', '/v1/tabs/s1/screen')).toBeNull()
    expect(parseRoute('GET', '/v1/other')).toBeNull()
    expect(parseRoute('GET', '/v1/tabs/../x')).toBeNull()
  })
})
