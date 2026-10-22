import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// These tests cover the riskiest thing this app does to files it does not own:
// hooks.ts rewrites the user's real ~/.claude/settings.json. A bug there
// silently destroys hand-written Claude Code config, so the "preserve
// everything we don't manage" contract is pinned down here.

let userData: string
let home: string
let schtasksCalls: string[][]

vi.mock('electron', () => ({
  app: {
    getPath: (name: string): string => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    }
  }
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const homedir = (): string => home
  return { ...actual, homedir, default: { ...actual, homedir } }
})

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFileSync: (file: string, args: string[]): Buffer => {
      schtasksCalls.push([file, ...args])
      return Buffer.from('')
    }
  }
})

const claudeSettings = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'))

let roots: string[] = []

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'lp-hooks-'))
  roots.push(root)
  userData = join(root, 'userData')
  home = join(root, 'home')
  mkdirSync(userData, { recursive: true })
  mkdirSync(join(home, '.claude'), { recursive: true })
  schtasksCalls = []
  vi.resetModules()
})

afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
  roots = []
})

describe('event hooks -> ~/.claude/settings.json', () => {
  it('writes an enabled hook under its event, with a matcher for tool events', async () => {
    const { createHook } = await import('./hooks')

    createHook({
      name: 'fmt',
      event: 'PreToolUse',
      matcher: 'Edit|Write',
      command: 'echo hi',
      enabled: true
    })

    const settings = claudeSettings()
    expect(settings.hooks).toEqual({
      PreToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'echo hi' }] }]
    })
  })

  it('defaults an empty matcher to * on tool events, and omits it elsewhere', async () => {
    const { createHook } = await import('./hooks')

    createHook({ name: 'a', event: 'PreToolUse', matcher: '  ', command: 'cmd-a', enabled: true })
    createHook({ name: 'b', event: 'SessionStart', matcher: 'ignored', command: 'cmd-b', enabled: true })

    const hooks = claudeSettings().hooks as Record<string, { matcher?: string }[]>
    expect(hooks.PreToolUse[0].matcher).toBe('*')
    expect(hooks.SessionStart[0]).not.toHaveProperty('matcher')
  })

  it("preserves unrelated settings keys and the user's own hooks", async () => {
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        model: 'opus',
        permissions: { allow: ['Bash'] },
        hooks: {
          PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'USER_OWN' }] }]
        }
      }),
      'utf8'
    )

    const { createHook } = await import('./hooks')
    createHook({ name: 'ours', event: 'PreToolUse', matcher: '*', command: 'OURS', enabled: true })

    const settings = claudeSettings()
    expect(settings.model).toBe('opus')
    expect(settings.permissions).toEqual({ allow: ['Bash'] })

    const commands = (settings.hooks as Record<string, { hooks: { command: string }[] }[]>).PreToolUse
      .flatMap((g) => g.hooks)
      .map((h) => h.command)
    expect(commands).toContain('USER_OWN')
    expect(commands).toContain('OURS')
  })

  it('removes only our command when the hook is disabled', async () => {
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'USER_OWN' }] }] }
      }),
      'utf8'
    )

    const { createHook, setHookEnabled } = await import('./hooks')
    const [hook] = createHook({ name: 'ours', event: 'Stop', matcher: '', command: 'OURS', enabled: true })
    setHookEnabled(hook.id, false)

    const commands = (claudeSettings().hooks as Record<string, { hooks: { command: string }[] }[]>).Stop
      .flatMap((g) => g.hooks)
      .map((h) => h.command)
    expect(commands).toEqual(['USER_OWN'])
  })

  it('drops the hooks key entirely once nothing is left in it', async () => {
    const { createHook, removeHook } = await import('./hooks')
    const [hook] = createHook({ name: 'ours', event: 'Stop', matcher: '', command: 'OURS', enabled: true })
    expect(claudeSettings()).toHaveProperty('hooks')

    removeHook(hook.id)
    expect(claudeSettings()).not.toHaveProperty('hooks')
  })

  it('ignores a hook whose command is blank', async () => {
    const { createHook } = await import('./hooks')
    createHook({ name: 'empty', event: 'Stop', matcher: '', command: '   ', enabled: true })
    expect(claudeSettings()).not.toHaveProperty('hooks')
  })

  it('refuses to write over a settings.json it cannot parse', async () => {
    const path = join(home, '.claude', 'settings.json')
    const original = '{ "model": "opus", not json'
    writeFileSync(path, original, 'utf8')

    const { createHook, listHooks } = await import('./hooks')
    expect(() =>
      createHook({ name: 'ours', event: 'Stop', matcher: '', command: 'OURS', enabled: true })
    ).toThrow(/settings\.json/)

    // The user's file must be byte-for-byte untouched — the old behaviour here
    // was to treat the parse failure as "empty" and overwrite it, silently
    // destroying every setting in it.
    expect(readFileSync(path, 'utf8')).toBe(original)
    // Our own hook is still recorded, so the UI can show it and retry later.
    expect(listHooks().map((h) => h.name)).toEqual(['ours'])
  })

  it('refuses to write when the file has a UTF-8 BOM but is otherwise valid JSON', async () => {
    // Notepad adds a BOM on save; JSON.parse rejects it. This must round-trip,
    // not be mistaken for corruption.
    const path = join(home, '.claude', 'settings.json')
    writeFileSync(path, '﻿{"model":"opus"}', 'utf8')

    const { createHook } = await import('./hooks')
    createHook({ name: 'ours', event: 'Stop', matcher: '', command: 'OURS', enabled: true })

    const settings = claudeSettings()
    expect(settings.model).toBe('opus')
    expect(settings.hooks).toBeDefined()
  })

  it('backs the file up before the first rewrite of a run', async () => {
    const path = join(home, '.claude', 'settings.json')
    writeFileSync(path, JSON.stringify({ model: 'opus' }), 'utf8')

    const { createHook } = await import('./hooks')
    createHook({ name: 'ours', event: 'Stop', matcher: '', command: 'OURS', enabled: true })

    expect(JSON.parse(readFileSync(`${path}.dashboard-bak`, 'utf8'))).toEqual({ model: 'opus' })
  })

  it('treats an empty settings.json as empty rather than corrupt', async () => {
    writeFileSync(join(home, '.claude', 'settings.json'), '   \n', 'utf8')

    const { createHook } = await import('./hooks')
    expect(() =>
      createHook({ name: 'ours', event: 'Stop', matcher: '', command: 'OURS', enabled: true })
    ).not.toThrow()
    expect(claudeSettings().hooks).toBeDefined()
  })
})

describe('Schedule hooks -> Windows Task Scheduler', () => {
  it('never leaks a Schedule hook into settings.json', async () => {
    const { createHook } = await import('./hooks')
    createHook({
      name: 'daily',
      event: 'Schedule',
      matcher: '',
      command: 'echo tick',
      enabled: true,
      schedule: { time: '09:00', days: [1, 2, 3, 4, 5] }
    })

    expect(claudeSettings()).not.toHaveProperty('hooks')
  })

  it('creates a weekly task backed by a generated .bat containing the command', async () => {
    const { createHook } = await import('./hooks')
    const [hook] = createHook({
      name: 'daily',
      event: 'Schedule',
      matcher: '',
      command: 'echo tick',
      enabled: true,
      schedule: { time: '09:00', days: [1, 5] }
    })

    const create = schtasksCalls.find((c) => c.includes('/create'))
    expect(create).toBeDefined()
    expect(create).toContain(`DashBoard_Hook_${hook.id}`)
    expect(create).toContain('WEEKLY')
    expect(create).toContain('09:00')
    expect(create).toContain('MON,FRI')

    const bat = join(userData, 'schedules', `${hook.id}.bat`)
    expect(existsSync(bat)).toBe(true)
    expect(readFileSync(bat, 'utf8')).toContain('echo tick')
  })

  it('treats an empty day list as DAILY', async () => {
    const { createHook } = await import('./hooks')
    createHook({
      name: 'daily',
      event: 'Schedule',
      matcher: '',
      command: 'echo tick',
      enabled: true,
      schedule: { time: '17:30', days: [] }
    })

    const create = schtasksCalls.find((c) => c.includes('/create'))
    expect(create).toContain('DAILY')
  })

  it('deletes the task when the hook is disabled', async () => {
    const { createHook, setHookEnabled } = await import('./hooks')
    const [hook] = createHook({
      name: 'daily',
      event: 'Schedule',
      matcher: '',
      command: 'echo tick',
      enabled: true,
      schedule: { time: '09:00', days: [] }
    })

    schtasksCalls = []
    setHookEnabled(hook.id, false)

    const del = schtasksCalls.find((c) => c.includes('/delete'))
    expect(del).toBeDefined()
    expect(del).toContain(`DashBoard_Hook_${hook.id}`)
  })
})

describe('sanitizeHookPatch (renderer input validation)', () => {
  it('rejects an event Claude Code does not have rather than defaulting it', async () => {
    const { createHook } = await import('./hooks')
    expect(() =>
      createHook({ name: 'x', event: 'OnCoffee' as never, matcher: '', command: 'c', enabled: true })
    ).toThrow(/未知的 hook 事件/)
  })

  it('drops wrongly-typed fields and unknown keys instead of storing them', async () => {
    const { sanitizeHookPatch } = await import('./hooks')
    const out = sanitizeHookPatch({
      name: 42,
      event: 'Stop',
      command: 'echo hi',
      enabled: 'yes',
      matcher: ['Bash'],
      extra: 'nope'
    })
    expect(out).toEqual({ event: 'Stop', command: 'echo hi' })
  })

  it('normalizes a schedule: valid time, deduped in-range days, or nothing', async () => {
    const { sanitizeHookPatch } = await import('./hooks')
    expect(sanitizeHookPatch({ schedule: { time: '09:05', days: [1, 1, 9, -1, 5] } }).schedule).toEqual({
      time: '09:05',
      days: [1, 5]
    })
    expect(sanitizeHookPatch({ schedule: { time: '25:00', days: [] } }).schedule).toBeUndefined()
    expect(sanitizeHookPatch({ schedule: 'tomorrow' }).schedule).toBeUndefined()
  })

  it('only touches the fields an update actually sends', async () => {
    const { createHook, updateHook } = await import('./hooks')
    const [hook] = createHook({ name: 'ours', event: 'Stop', matcher: '', command: 'OURS', enabled: true })
    const [updated] = updateHook(hook.id, { enabled: 'maybe' as never, name: 'renamed' })
    expect(updated.name).toBe('renamed')
    expect(updated.enabled).toBe(true)
    expect(updated.command).toBe('OURS')
  })
})
