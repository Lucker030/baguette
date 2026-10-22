import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// This file is written by two authors: the app, and a Claude Code session
// editing the JSON by hand (the `daily-todos` skill). So the tests centre on
// tolerating whatever a hand-written entry looks like — that is the failure
// mode that would otherwise blank the panel.

let userData: string
let roots: string[] = []

vi.mock('electron', () => ({
  app: {
    getPath: (name: string): string => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    }
  }
}))

const file = (): string => join(userData, 'todos.json')
const readFile = () => JSON.parse(readFileSync(file(), 'utf8'))

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'lp-todos-'))
  roots.push(root)
  userData = join(root, 'userData')
  mkdirSync(userData, { recursive: true })
  vi.resetModules()
})

afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
  roots = []
})

describe('todayKey', () => {
  it('uses the LOCAL calendar day, not UTC', async () => {
    const { todayKey } = await import('./todos')
    // 23:30 local on the 20th is already the 21st in UTC+0 for this timezone;
    // the list must still call it the 20th or "today" flips mid-evening.
    expect(todayKey(new Date(2026, 7, 20, 23, 30))).toBe('2026-08-20')
    expect(todayKey(new Date(2026, 0, 5, 0, 1))).toBe('2026-01-05')
  })
})

describe('reading', () => {
  it('starts empty when there is no file', async () => {
    const { listTodos } = await import('./todos')
    expect(listTodos()).toEqual([])
  })

  it('starts empty rather than throwing on a corrupt file', async () => {
    writeFileSync(file(), '{ not json', 'utf8')
    const { listTodos } = await import('./todos')
    expect(listTodos()).toEqual([])
  })

  it('fills in everything a hand-written entry left out', async () => {
    // The minimum a person would plausibly type into the file.
    writeFileSync(file(), JSON.stringify({ items: [{ text: '寫週報' }] }), 'utf8')
    const { listTodos, todayKey } = await import('./todos')

    const [item] = listTodos()
    expect(item.text).toBe('寫週報')
    expect(item.done).toBe(false)
    expect(item.date).toBe(todayKey())
    expect(item.id).toBeTruthy()
    expect(typeof item.createdAt).toBe('number')
  })

  it('drops entries with no usable text', async () => {
    writeFileSync(
      file(),
      JSON.stringify({ items: [{ text: '  ' }, null, { done: true }, { text: '真的有事' }] }),
      'utf8'
    )
    const { listTodos } = await import('./todos')
    expect(listTodos().map((t) => t.text)).toEqual(['真的有事'])
  })

  it('rejects a malformed date instead of showing it as its own day', async () => {
    writeFileSync(file(), JSON.stringify({ items: [{ text: 'x', date: '8/20' }] }), 'utf8')
    const { listTodos, todayKey } = await import('./todos')
    expect(listTodos()[0].date).toBe(todayKey())
  })

  it('sorts newest day first', async () => {
    writeFileSync(
      file(),
      JSON.stringify({
        items: [
          { text: 'old', date: '2026-08-18' },
          { text: 'new', date: '2026-08-20' },
          { text: 'mid', date: '2026-08-19' }
        ]
      }),
      'utf8'
    )
    const { listTodos } = await import('./todos')
    expect(listTodos().map((t) => t.text)).toEqual(['new', 'mid', 'old'])
  })
})

describe('writing', () => {
  it('adds items for today by default', async () => {
    const { addTodos, todayKey } = await import('./todos')
    const list = addTodos(['甲', '乙'])

    expect(list.map((t) => t.text).sort()).toEqual(['乙', '甲'])
    expect(list.every((t) => t.date === todayKey())).toBe(true)
    expect(readFile().items).toHaveLength(2)
  })

  it('accepts an explicit date and marks the source', async () => {
    const { addTodos } = await import('./todos')
    const list = addTodos(['明天的事'], '2026-08-21', 'claude')
    expect(list[0].date).toBe('2026-08-21')
    expect(list[0].source).toBe('claude')
  })

  it('ignores blank lines rather than creating empty rows', async () => {
    const { addTodos } = await import('./todos')
    expect(addTodos(['有事', '   ', ''])).toHaveLength(1)
  })

  it('gives every item a distinct id, even added together', async () => {
    const { addTodos } = await import('./todos')
    const list = addTodos(['a', 'b', 'c'])
    expect(new Set(list.map((t) => t.id)).size).toBe(3)
  })

  it('toggles, edits and removes by id', async () => {
    const { addTodos, setTodoDone, updateTodoText, removeTodo } = await import('./todos')
    const [item] = addTodos(['原本'])

    expect(setTodoDone(item.id, true)[0].done).toBe(true)
    expect(updateTodoText(item.id, '改過')[0].text).toBe('改過')
    expect(removeTodo(item.id)).toEqual([])
  })

  it('refuses to blank an item by editing it to whitespace', async () => {
    const { addTodos, updateTodoText } = await import('./todos')
    const [item] = addTodos(['保留我'])
    expect(updateTodoText(item.id, '   ')[0].text).toBe('保留我')
  })

  it('clears finished items across every day', async () => {
    const { addTodos, setTodoDone, clearDoneTodos } = await import('./todos')
    const [a] = addTodos(['做完的'])
    addTodos(['還沒做的'], '2026-08-19')
    setTodoDone(a.id, true)

    expect(clearDoneTodos().map((t) => t.text)).toEqual(['還沒做的'])
  })

  it('writes a file the skill can read back', async () => {
    const { addTodos } = await import('./todos')
    addTodos(['x'])
    const raw = readFile()
    expect(raw.version).toBe(1)
    expect(Array.isArray(raw.items)).toBe(true)
    expect(raw.items[0]).toMatchObject({ text: 'x', done: false })
  })
})

describe('picking up an external edit', () => {
  it('re-reads the file after invalidateTodos', async () => {
    const { addTodos, listTodos, invalidateTodos } = await import('./todos')
    addTodos(['app 加的'])

    // Simulate the skill appending to the file behind the app's back.
    const raw = readFile()
    raw.items.push({ text: 'Claude 指派的', source: 'claude' })
    writeFileSync(file(), JSON.stringify(raw), 'utf8')

    // Still the cached copy until told otherwise…
    expect(listTodos()).toHaveLength(1)
    invalidateTodos()
    expect(listTodos().map((t) => t.text).sort()).toEqual(['Claude 指派的', 'app 加的'])
  })
})
