import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import type { FetchLike } from './updater'

// The GitHub updater decides whether to offer an installer and whether to
// trust it. Picking an older build, or verifying against the wrong
// latest.yml, would either nag forever or refuse a good update — so the
// selection rules are pinned here against canned API responses. The hand-off
// to NSIS itself is not run.

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), quit: () => {} }, net: { fetch: () => {} } }))

const API = 'https://api.github.com/repos/Lucker030/baguette/releases/latest'
const YML = 'https://github.com/Lucker030/baguette/releases/download/v0.28.0/latest.yml'

function asset(name: string, size = 80_000_000): Record<string, unknown> {
  return { name, size, browser_download_url: `https://github.com/Lucker030/baguette/releases/download/x/${name}` }
}

/** A fetch double serving fixed bodies per URL; anything else is a 404. */
function fakeFetch(routes: Record<string, { status?: number; body: string }>): FetchLike {
  return async (url) => {
    const r = routes[url]
    return r ? new Response(r.body, { status: r.status ?? 200 }) : new Response('', { status: 404 })
  }
}

function release(assets: Record<string, unknown>[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ html_url: 'https://github.com/Lucker030/baguette/releases/tag/v0.28.0', assets, ...extra })
}

describe('parseInstallerName / compareVersions', () => {
  it('reads the version out of the installer filename and nothing else', async () => {
    const { parseInstallerName } = await import('./updater')
    expect(parseInstallerName('baguette-Setup-0.27.0.exe')).toBe('0.27.0')
    // GitHub rewrites spaces in uploaded asset names to dots.
    expect(parseInstallerName('baguette.Setup.1.2.3.exe')).toBe('1.2.3')
    expect(parseInstallerName('Baguette Setup 1.2.3.EXE')).toBe('1.2.3')
    expect(parseInstallerName('baguette-Setup-0.27.0.exe.blockmap')).toBeNull()
    expect(parseInstallerName('Local Platform Setup 0.27.0.exe')).toBeNull()
    expect(parseInstallerName('latest.yml')).toBeNull()
  })

  it('compares numerically, not lexically', async () => {
    const { compareVersions } = await import('./updater')
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('0.27.0', '0.27.1')).toBe(-1)
  })
})

describe('pickRelease', () => {
  it('ignores drafts, prereleases and assets with non-https urls', async () => {
    const { pickRelease } = await import('./updater')
    const assets = [asset('baguette-Setup-0.28.0.exe')]
    expect(pickRelease({ assets, draft: true }, '0.27.0')).toBeNull()
    expect(pickRelease({ assets, prerelease: true }, '0.27.0')).toBeNull()
    expect(
      pickRelease({ assets: [{ name: 'baguette-Setup-0.28.0.exe', size: 1, browser_download_url: 'file:///x' }] }, '0.27.0')
    ).toBeNull()
    expect(pickRelease('not json', '0.27.0')).toBeNull()
  })
})

describe('checkForUpdate', () => {
  it('offers the installer when the release is newer than the running build', async () => {
    const { checkForUpdate } = await import('./updater')
    const r = await checkForUpdate(
      '0.27.0',
      fakeFetch({ [API]: { body: release([asset('baguette-Setup-0.28.0.exe'), asset('__uninstaller-nsis-baguette.exe')]) } })
    )
    expect(r.latestVersion).toBe('0.28.0')
    expect(r.fileName).toBe('baguette-Setup-0.28.0.exe')
    expect(r.size).toBe(80_000_000)
    expect(r.sha512).toBeNull()
    expect(r.error).toBeUndefined()
  })

  it('reports nothing when the running build is already the newest', async () => {
    const { checkForUpdate } = await import('./updater')
    const r = await checkForUpdate('0.28.0', fakeFetch({ [API]: { body: release([asset('baguette-Setup-0.28.0.exe')]) } }))
    expect(r.latestVersion).toBeNull()
    expect(r.url).toBeNull()
  })

  it('takes the sha512 from latest.yml only when it describes the chosen installer', async () => {
    const { checkForUpdate } = await import('./updater')
    const yml = [
      'version: 0.28.0',
      'files:',
      '  - url: baguette-Setup-0.28.0.exe',
      '    sha512: inner-should-be-ignored',
      '    size: 1',
      'path: baguette-Setup-0.28.0.exe',
      'sha512: TOPLEVELHASH==',
      "releaseDate: '2026-10-15T00:00:00.000Z'"
    ].join('\n')
    const ymlAsset = { name: 'latest.yml', size: 1, browser_download_url: YML }

    const ok = await checkForUpdate(
      '0.27.0',
      fakeFetch({ [API]: { body: release([asset('baguette-Setup-0.28.0.exe'), ymlAsset]) }, [YML]: { body: yml } })
    )
    expect(ok.sha512).toBe('TOPLEVELHASH==')

    // A newer installer uploaded by hand next to a stale latest.yml.
    const stale = await checkForUpdate(
      '0.27.0',
      fakeFetch({ [API]: { body: release([asset('baguette-Setup-0.29.0.exe'), ymlAsset]) }, [YML]: { body: yml } })
    )
    expect(stale.latestVersion).toBe('0.29.0')
    expect(stale.sha512).toBeNull()
  })

  it('turns network and HTTP failures into an error, not a throw', async () => {
    const { checkForUpdate } = await import('./updater')
    expect((await checkForUpdate('0.27.0', fakeFetch({}))).error).toMatch(/還沒有發布/)
    expect((await checkForUpdate('0.27.0', fakeFetch({ [API]: { status: 403, body: '' } }))).error).toMatch(/限流/)
    const offline: FetchLike = async () => {
      throw new Error('ENOTFOUND')
    }
    expect((await checkForUpdate('0.27.0', offline)).error).toMatch(/連不上 GitHub/)
  })
})

describe('installUpdate', () => {
  it('refuses a download whose size does not match what GitHub listed', async () => {
    const { installUpdate } = await import('./updater')
    const url = 'https://example.invalid/baguette-Setup-0.28.0.exe'
    await expect(
      installUpdate(
        {
          currentVersion: '0.27.0',
          latestVersion: '0.28.0',
          url,
          fileName: 'baguette-Setup-0.28.0.exe',
          size: 80_000_000,
          sha512: null,
          releaseUrl: '',
          checkedAt: 0
        },
        fakeFetch({ [url]: { body: 'tiny' } })
      )
    ).rejects.toThrow(/大小不符/)
  })
})
