import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// This file is written by two authors, the
// app and a Claude Code session editing the JSON by hand (the
// `knowledge-capture` skill). Tests centre on tolerating whatever a
// hand-written entry looks like — that is the failure mode that would
// otherwise blank the panel.

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

const file = (): string => join(userData, 'knowledge.json')
const readFile = () => JSON.parse(readFileSync(file(), 'utf8'))

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'lp-knowledge-'))
  roots.push(root)
  userData = join(root, 'userData')
  mkdirSync(userData, { recursive: true })
  vi.resetModules()
})

afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
  roots = []
})

describe('reading', () => {
  it('starts empty when there is no file', async () => {
    const { listKnowledge } = await import('./knowledge')
    expect(listKnowledge()).toEqual([])
  })

  it('starts empty rather than throwing on a corrupt file', async () => {
    writeFileSync(file(), '{ not json', 'utf8')
    const { listKnowledge } = await import('./knowledge')
    expect(listKnowledge()).toEqual([])
  })

  it('fills in everything a hand-written entry left out', async () => {
    writeFileSync(file(), JSON.stringify({ items: [{ content: '踩過的坑' }] }), 'utf8')
    const { listKnowledge } = await import('./knowledge')

    const [item] = listKnowledge()
    expect(item.content).toBe('踩過的坑')
    expect(item.title).toBe('踩過的坑') // no title given — falls back to the content
    expect(item.tags).toEqual([])
    expect(item.source).toBe('app')
    expect(item.id).toBeTruthy()
    expect(typeof item.createdAt).toBe('number')
    expect(typeof item.updatedAt).toBe('number')
  })

  it('drops entries with no usable title or content', async () => {
    writeFileSync(
      file(),
      JSON.stringify({ items: [{ content: '  ' }, null, { tags: ['x'] }, { title: '有標題' }] }),
      'utf8'
    )
    const { listKnowledge } = await import('./knowledge')
    expect(listKnowledge().map((k) => k.title)).toEqual(['有標題'])
  })

  it('dedupes and trims hand-written tags', async () => {
    writeFileSync(
      file(),
      JSON.stringify({ items: [{ title: 't', tags: [' 專案A ', '專案A', '', 'x'] }] }),
      'utf8'
    )
    const { listKnowledge } = await import('./knowledge')
    expect(listKnowledge()[0].tags).toEqual(['專案A', 'x'])
  })

  it('sorts most recently updated first', async () => {
    writeFileSync(
      file(),
      JSON.stringify({
        items: [
          { title: 'old', updatedAt: 100 },
          { title: 'new', updatedAt: 300 },
          { title: 'mid', updatedAt: 200 }
        ]
      }),
      'utf8'
    )
    const { listKnowledge } = await import('./knowledge')
    expect(listKnowledge().map((k) => k.title)).toEqual(['new', 'mid', 'old'])
  })
})

describe('writing notes', () => {
  it('adds an entry with title, content and tags', async () => {
    const { addKnowledge } = await import('./knowledge')
    const list = addKnowledge({ title: '標題', content: '內容', tags: ['tag1', 'tag2'] })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      kind: 'note',
      title: '標題',
      content: '內容',
      tags: ['tag1', 'tag2'],
      source: 'app'
    })
    expect(readFile().items).toHaveLength(1)
  })

  it('falls back to content for the title when none is given', async () => {
    const { addKnowledge } = await import('./knowledge')
    const list = addKnowledge({ content: '這是一段很長的內容用來當標題的開頭' })
    expect(list[0].title).toBe('這是一段很長的內容用來當標題的開頭')
  })

  it('marks the source for captured entries', async () => {
    const { addKnowledge } = await import('./knowledge')
    const list = addKnowledge({ content: '心得' }, 'claude')
    expect(list[0].source).toBe('claude')
  })

  it('ignores an add with nothing usable', async () => {
    const { addKnowledge } = await import('./knowledge')
    expect(addKnowledge({ title: '  ', content: '  ' })).toEqual([])
  })

  it('updates fields and bumps updatedAt without touching createdAt', async () => {
    const { addKnowledge, updateKnowledge } = await import('./knowledge')
    const [entry] = addKnowledge({ title: '原標題', content: '原內容' })

    const updated = updateKnowledge(entry.id, { title: '新標題', tags: ['new'] })[0]
    expect(updated.title).toBe('新標題')
    expect(updated.content).toBe('原內容') // untouched field survives a partial patch
    expect(updated.tags).toEqual(['new'])
    expect(updated.createdAt).toBe(entry.createdAt)
    expect(updated.updatedAt).toBeGreaterThanOrEqual(entry.updatedAt)
  })

  it('removes by id', async () => {
    const { addKnowledge, removeKnowledge } = await import('./knowledge')
    const [entry] = addKnowledge({ title: 't', content: 'c' })
    expect(removeKnowledge(entry.id)).toEqual([])
  })

  it('writes a file the skill can read back', async () => {
    const { addKnowledge } = await import('./knowledge')
    addKnowledge({ title: 't', content: 'c' })
    const raw = readFile()
    expect(raw.version).toBe(1)
    expect(Array.isArray(raw.items)).toBe(true)
    expect(raw.items[0]).toMatchObject({ title: 't', content: 'c' })
  })
})

describe('the db-index kind', () => {
  it('defaults kind to note for entries that predate the field', async () => {
    writeFileSync(file(), JSON.stringify({ items: [{ title: '舊筆記' }] }), 'utf8')
    const { listKnowledge } = await import('./knowledge')
    expect(listKnowledge()[0].kind).toBe('note')
  })

  it('adds a db entry keyed by dbFile, with title falling back to it', async () => {
    const { addKnowledge } = await import('./knowledge')
    const list = addKnowledge({ kind: 'db', dbFile: 'ort_test.db', content: 'ort_checklist_items(...)' })
    expect(list[0]).toMatchObject({ kind: 'db', dbFile: 'ort_test.db', title: 'ort_test.db' })
  })

  it('keeps dbFile out of note entries and title out of db entries\' identity', async () => {
    const { addKnowledge } = await import('./knowledge')
    const list = addKnowledge({ title: '一般筆記', content: 'x' })
    expect(list[0].dbFile).toBeUndefined()
  })

  it('accepts a dbFile alone with no content', async () => {
    const { addKnowledge } = await import('./knowledge')
    expect(addKnowledge({ kind: 'db', dbFile: 'inventory.db' })).toHaveLength(1)
  })

  it('lets an update change an entry from note to db kind', async () => {
    const { addKnowledge, updateKnowledge } = await import('./knowledge')
    const [entry] = addKnowledge({ title: 'x', content: 'y' })
    const updated = updateKnowledge(entry.id, { kind: 'db', dbFile: 'x.db' })[0]
    expect(updated.kind).toBe('db')
    expect(updated.dbFile).toBe('x.db')
  })
})

describe('picking up an external edit', () => {
  it('re-reads the file after invalidateKnowledge', async () => {
    const { addKnowledge, listKnowledge, invalidateKnowledge } = await import('./knowledge')
    addKnowledge({ title: 'app 加的' })

    // Simulate the skill appending to the file behind the app's back.
    const raw = readFile()
    raw.items.push({ title: 'Claude 寫的', content: '', source: 'claude' })
    writeFileSync(file(), JSON.stringify(raw), 'utf8')

    expect(listKnowledge()).toHaveLength(1)
    invalidateKnowledge()
    expect(listKnowledge().map((k) => k.title).sort()).toEqual(['Claude 寫的', 'app 加的'])
  })
})
