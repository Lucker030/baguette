import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

// providers.ts decides which binary a tab launches and, for the WSL fallback,
// where Claude keeps that tab's transcripts. Both rules were worked out
// empirically against this machine and are easy to break by "tidying" — so
// the pure pieces are pinned here. (The WSL probes themselves shell out and
// are not exercised.)

// which() also reads the machine's live PATH from the registry via
// `reg query`. Block that here so these tests see only the PATH they set —
// otherwise a real python.exe on the test machine's PATH would be "found".
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: () => {
    throw new Error('registry lookup disabled in tests')
  }
}))

let root: string
const savedPath = process.env.PATH
const savedPathExt = process.env.PATHEXT

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lp-providers-'))
})

afterEach(() => {
  process.env.PATH = savedPath
  process.env.PATHEXT = savedPathExt
  rmSync(root, { recursive: true, force: true })
  vi.resetModules()
})

describe('toWslPath', () => {
  it('maps a Windows drive path onto /mnt/<drive>', async () => {
    const { toWslPath } = await import('./providers')
    expect(toWslPath('C:\\Users\\me\\proj')).toBe('/mnt/c/Users/me/proj')
    expect(toWslPath('d:/work')).toBe('/mnt/d/work')
  })

  it('leaves anything that is not a drive path alone', async () => {
    const { toWslPath } = await import('./providers')
    expect(toWslPath('/home/me')).toBe('/home/me')
    expect(toWslPath('\\\\server\\share')).toBe('\\\\server\\share')
  })
})

describe('claudeProjectDirName', () => {
  it("replaces every non-alphanumeric character with its own '-', no collapsing", async () => {
    const { claudeProjectDirName } = await import('./providers')
    expect(claudeProjectDirName('/mnt/c/Users/me/my_baguette')).toBe('-mnt-c-Users-me-my-baguette')
    // A CJK character is one code unit here... unless it is a surrogate pair,
    // which is why this deliberately uses BMP characters: one char, one dash.
    expect(claudeProjectDirName('/mnt/c/Users/林郁宸/x')).toBe('-mnt-c-Users-----x')
  })
})

describe('WSL probe parsing', () => {
  it('reads every CLI found by one `command -v` call, by basename', async () => {
    const { parseWslProbe } = await import('./providers')
    const out = '/home/white/.local/bin/claude\n/usr/local/bin/agy\n__baguette_probe_done__\n'
    expect([...parseWslProbe(out)!].sort()).toEqual(['agy', 'claude'])
  })

  it('treats a reply without the end marker as no answer, not "nothing installed"', async () => {
    const { parseWslProbe } = await import('./providers')
    // A cold WSL that timed out, or wsl.exe printing an error.
    expect(parseWslProbe('')).toBeNull()
    expect(parseWslProbe('/home/white/.local/bin/claude\n')).toBeNull()
    // A complete answer that found nothing is an empty set.
    expect(parseWslProbe('__baguette_probe_done__\r\n')?.size).toBe(0)
  })

  it('ignores lines that only look like a match', async () => {
    const { parseWslProbe } = await import('./providers')
    expect(parseWslProbe('/opt/claude-tools/bin/claudex\n__baguette_probe_done__')?.size).toBe(0)
  })
})

describe('pickRuntime', () => {
  it('auto prefers Windows and falls back to WSL', async () => {
    const { pickRuntime } = await import('./providers')
    expect(pickRuntime('auto', true, () => true)).toBe('windows')
    expect(pickRuntime('auto', false, () => true)).toBe('wsl')
    expect(pickRuntime('auto', false, () => false)).toBeNull()
  })

  it('a forced runtime never falls back to the other one', async () => {
    const { pickRuntime } = await import('./providers')
    expect(pickRuntime('wsl', true, () => true)).toBe('wsl')
    expect(pickRuntime('wsl', true, () => false)).toBeNull()
    expect(pickRuntime('windows', false, () => true)).toBeNull()
  })

  it('does not ask WSL when the Windows install already decides it', async () => {
    const { pickRuntime } = await import('./providers')
    let asked = false
    pickRuntime('auto', true, () => (asked = true))
    expect(asked).toBe(false)
  })
})

describe('extraLocations', () => {
  const home = 'C:\\Users\\me'
  const env = { APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }

  it('covers the official installers and every package manager, Windows-runnable names only', async () => {
    const { extraLocations } = await import('./providers')
    const codex = extraLocations('codex', home, env)
    expect(codex[0]).toBe(join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'))
    expect(codex).toContain(join(env.APPDATA, 'npm', 'codex.cmd'))
    expect(codex).toContain(join(env.LOCALAPPDATA, 'pnpm', 'codex.cmd'))
    expect(codex).toContain(join(home, 'scoop', 'shims', 'codex.exe'))
    expect(codex).toContain(join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'codex.exe'))
    // npm's bare `codex` is a POSIX sh shim Windows cannot run.
    expect(codex).not.toContain(join(env.APPDATA, 'npm', 'codex'))
    expect(extraLocations('claude', home, env)).toContain(join(env.APPDATA, 'npm', 'claude.cmd'))
    expect(extraLocations('copilot', home, env)).toContain(join(env.APPDATA, 'npm', 'copilot.cmd'))
  })

  it("uses Antigravity's real executable name, agy", async () => {
    const { extraLocations } = await import('./providers')
    const agy = extraLocations('antigravity', home, env)
    expect(agy[0]).toBe(join(env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe'))
    expect(agy).toContain(join(env.APPDATA, 'npm', 'agy.cmd'))
  })
})

describe('registry PATH parsing', () => {
  it('reads the Path value out of reg query output, either value type', async () => {
    const { parseRegQueryPath } = await import('./providers')
    const out = [
      '',
      'HKEY_CURRENT_USER\\Environment',
      '    Path    REG_EXPAND_SZ    %LOCALAPPDATA%\\agy\\bin;C:\\Tools',
      ''
    ].join('\r\n')
    expect(parseRegQueryPath(out)).toBe('%LOCALAPPDATA%\\agy\\bin;C:\\Tools')
    expect(parseRegQueryPath('    Path    REG_SZ    C:\\x')).toBe('C:\\x')
    expect(parseRegQueryPath('ERROR: The system was unable to find the specified registry key or value.')).toBe('')
  })

  it('expands %VAR% case-insensitively and leaves unknown ones alone', async () => {
    const { expandWinEnv } = await import('./providers')
    const env = { LocalAppData: 'C:\\Users\\me\\AppData\\Local' }
    expect(expandWinEnv('%LOCALAPPDATA%\\agy\\bin', env)).toBe('C:\\Users\\me\\AppData\\Local\\agy\\bin')
    expect(expandWinEnv('%NOPE%\\bin', env)).toBe('%NOPE%\\bin')
  })
})

describe('which', () => {
  it('prefers the PATHEXT variant Windows can actually run over the bare shim', async () => {
    if (process.platform !== 'win32') return
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\n') // npm's POSIX shim
    writeFileSync(join(bin, 'codex.cmd'), '@echo off\n')
    process.env.PATH = bin
    process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD'
    const { which } = await import('./providers')
    expect(which('codex')?.toLowerCase()).toBe(join(bin, 'codex.cmd').toLowerCase())
  })

  it('does not mistake a directory for an executable', async () => {
    const bin = join(root, 'bin')
    mkdirSync(join(bin, 'python'), { recursive: true })
    process.env.PATH = bin
    process.env.PATHEXT = '.EXE'
    const { which } = await import('./providers')
    expect(which('python')).toBeUndefined()
  })

  it('returns undefined when nothing on PATH matches', async () => {
    process.env.PATH = join(root, 'nope')
    const { which } = await import('./providers')
    expect(which('definitely-not-installed')).toBeUndefined()
  })
})

describe('claudeProjectDirectory', () => {
  // A native Windows claude.exe used to make this return null, so no tab ever
  // learned its conversation id and every restored tab ran --continue into
  // the same conversation. Pin the native layout the main PC really uses.
  beforeEach(() => {
    writeFileSync(join(root, 'claude.exe'), '')
    writeFileSync(join(root, 'claude'), '', { mode: 0o755 })
    process.env.PATH = root
    process.env.PATHEXT = '.EXE'
  })

  it("finds a native Windows account's transcripts under its config dir", async () => {
    const { claudeProjectDirectory } = await import('./providers')
    const account = join(root, 'accounts', 'account')
    expect(await claudeProjectDirectory('D:\\baguette', account)).toBe(join(account, 'projects', 'D--baguette'))
  })

  it('uses ~/.claude for the default native account', async () => {
    const { claudeProjectDirectory } = await import('./providers')
    expect(await claudeProjectDirectory('D:\\baguette')).toBe(join(homedir(), '.claude', 'projects', 'D--baguette'))
  })
})
