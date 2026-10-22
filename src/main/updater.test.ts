import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The folder-based updater decides whether to offer an installer and whether
// to trust it. Picking an older build, or verifying against the wrong
// latest.yml, would either nag forever or refuse a good update — so the
// selection rules are pinned here. The hand-off to NSIS itself is not run.

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lp-update-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('parseInstallerName / compareVersions', () => {
  it('reads the version out of the installer filename and nothing else', async () => {
    const { parseInstallerName } = await import('./updater')
    expect(parseInstallerName('Local Platform Setup 0.27.0.exe')).toBe('0.27.0')
    expect(parseInstallerName('local platform setup 1.2.3.EXE')).toBe('1.2.3')
    expect(parseInstallerName('Local Platform Setup 0.27.0.exe.blockmap')).toBeNull()
    expect(parseInstallerName('latest.yml')).toBeNull()
  })

  it('compares numerically, not lexically', async () => {
    const { compareVersions } = await import('./updater')
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('0.27.0', '0.27.1')).toBe(-1)
  })
})

describe('checkForUpdate', () => {
  it('offers the newest installer that is newer than the running build', async () => {
    const { checkForUpdate } = await import('./updater')
    for (const v of ['0.24.1', '0.26.0', '0.27.0', '0.30.0']) {
      writeFileSync(join(root, `Local Platform Setup ${v}.exe`), '')
    }
    const r = checkForUpdate(root, '0.27.0')
    expect(r.latestVersion).toBe('0.30.0')
    expect(r.file).toBe(join(root, 'Local Platform Setup 0.30.0.exe'))
    expect(r.sha512).toBeNull()
    expect(r.error).toBeUndefined()
  })

  it('reports nothing when the running build is already the newest', async () => {
    const { checkForUpdate } = await import('./updater')
    writeFileSync(join(root, 'Local Platform Setup 0.27.0.exe'), '')
    const r = checkForUpdate(root, '0.27.0')
    expect(r.latestVersion).toBeNull()
    expect(r.file).toBeNull()
  })

  it('takes the sha512 from latest.yml only when it describes the chosen installer', async () => {
    const { checkForUpdate } = await import('./updater')
    writeFileSync(join(root, 'Local Platform Setup 0.28.0.exe'), '')
    writeFileSync(
      join(root, 'latest.yml'),
      [
        'version: 0.28.0',
        'files:',
        '  - url: Local Platform Setup 0.28.0.exe',
        '    sha512: inner-should-be-ignored',
        '    size: 1',
        'path: Local Platform Setup 0.28.0.exe',
        'sha512: TOPLEVELHASH==',
        "releaseDate: '2026-10-15T00:00:00.000Z'"
      ].join('\n')
    )
    expect(checkForUpdate(root, '0.27.0').sha512).toBe('TOPLEVELHASH==')

    // A newer installer copied in by hand next to a stale latest.yml.
    writeFileSync(join(root, 'Local Platform Setup 0.29.0.exe'), '')
    const r = checkForUpdate(root, '0.27.0')
    expect(r.latestVersion).toBe('0.29.0')
    expect(r.sha512).toBeNull()
  })

  it('turns an unreadable folder into an error, not a throw', async () => {
    const { checkForUpdate } = await import('./updater')
    const r = checkForUpdate(join(root, 'missing'), '0.27.0')
    expect(r.error).toMatch(/讀不到資料夾/)
    expect(checkForUpdate('', '0.27.0').error).toMatch(/尚未設定/)
  })

  it('ignores subfolders and unrelated files', async () => {
    const { checkForUpdate } = await import('./updater')
    mkdirSync(join(root, 'win-unpacked'))
    writeFileSync(join(root, 'builder-debug.yml'), '')
    expect(checkForUpdate(root, '0.27.0').latestVersion).toBeNull()
  })
})

describe('installUpdate', () => {
  it('refuses a suspiciously small installer before touching anything', async () => {
    const { installUpdate } = await import('./updater')
    const file = join(root, 'Local Platform Setup 0.28.0.exe')
    writeFileSync(file, 'tiny')
    expect(() =>
      installUpdate({ currentVersion: '0.27.0', latestVersion: '0.28.0', file, sha512: null, checkedAt: 0 })
    ).toThrow(/不完整/)
  })
})
