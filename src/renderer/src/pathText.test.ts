import { describe, expect, it } from 'vitest'
import { quoteForShell } from './pathText'

describe('quoteForShell', () => {
  it('leaves a plain path alone', () => {
    expect(quoteForShell('C:\\work\\a.txt')).toBe('C:\\work\\a.txt')
  })

  it('quotes a path containing a space', () => {
    // The common case on Windows: "Program Files", "My Projects", OneDrive.
    expect(quoteForShell('C:\\My Projects\\a.txt')).toBe('"C:\\My Projects\\a.txt"')
  })

  it('quotes other whitespace too', () => {
    expect(quoteForShell('C:\\a\tb')).toBe('"C:\\a\tb"')
  })

  it('does not double-quote an already quoted path', () => {
    expect(quoteForShell('"C:\\My Projects\\a.txt"')).toBe('"C:\\My Projects\\a.txt"')
  })

  it('passes an empty string through', () => {
    expect(quoteForShell('')).toBe('')
  })
})
