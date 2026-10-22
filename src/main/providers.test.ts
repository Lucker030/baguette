import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// providers.ts decides which binary a tab launches and, for the WSL fallback,
// where Claude keeps that tab's transcripts. Both rules were worked out
// empirically against this machine and are easy to break by "tidying" — so
// the pure pieces are pinned here. (The WSL probes themselves shell out and
// are not exercised.)

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
    expect(claudeProjectDirName('/mnt/c/Users/me/Local_Platform')).toBe('-mnt-c-Users-me-Local-Platform')
    // A CJK character is one code unit here... unless it is a surrogate pair,
    // which is why this deliberately uses BMP characters: one char, one dash.
    expect(claudeProjectDirName('/mnt/c/Users/林郁宸/x')).toBe('-mnt-c-Users-----x')
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
