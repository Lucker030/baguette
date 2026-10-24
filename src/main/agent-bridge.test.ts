import { describe, expect, it } from 'vitest'
import { dropInputBox, isCommandLine, parseRoute, pasteSequence, replyAfter, tidyLines } from './agent-bridge'

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

  it('rejects wrong methods and unknown paths', () => {
    expect(parseRoute('DELETE', '/v1/tabs')).toBeNull()
    expect(parseRoute('GET', '/v1/tabs/s1/input')).toBeNull()
    expect(parseRoute('POST', '/v1/tabs/s1/screen')).toBeNull()
    expect(parseRoute('GET', '/v1/other')).toBeNull()
    expect(parseRoute('GET', '/v1/tabs/../x')).toBeNull()
  })
})
