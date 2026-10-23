import { app, net } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'
import type { UpdateCheckResult } from '../shared/types'
import { log } from './log'

// Updates from this project's GitHub Releases.
//
// .github/workflows/release.yml builds the NSIS installer on every `v*` tag
// and attaches it to a Release together with electron-builder's latest.yml.
// This does what electron-updater's github provider would, without the
// dependency:
//
//   1. ask the GitHub API for the latest (non-draft, non-prerelease) Release
//      and find a `baguette-Setup-<ver>.exe` asset newer than the running
//      build;
//   2. if the Release also carries latest.yml, take the sha512 from it — the
//      download is verified against that before anything runs;
//   3. download the installer to a temp folder, launch it silently with the
//      same flags electron-updater uses, and quit. The NSIS script waits for
//      this process to exit, kills it if it doesn't, installs, and relaunches
//      the app (`--force-run`).

export const GITHUB_REPO = 'Lucker030/baguette'
export const RELEASES_PAGE = `https://github.com/${GITHUB_REPO}/releases`
const LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`

// electron-builder.yml names the installer `baguette-Setup-<ver>.exe`. GitHub
// also turns spaces in an uploaded asset name into dots, so a hand-uploaded
// `baguette Setup 1.2.3.exe` arrives as `baguette.Setup.1.2.3.exe` — accept
// any of the three separators.
const INSTALLER_RE = /^baguette[ .-]Setup[ .-](\d+)\.(\d+)\.(\d+)\.exe$/i

/** `'baguette-Setup-1.2.0.exe'` → `'1.2.0'`, or null for anything else. */
export function parseInstallerName(name: string): string | null {
  const m = INSTALLER_RE.exec(name)
  return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : null
}

/** Numeric semver compare on major.minor.patch; anything unparseable sorts lowest. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10))
  const pb = b.split('.').map((n) => Number.parseInt(n, 10))
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : -1
    const y = Number.isFinite(pb[i]) ? pb[i] : -1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/**
 * The three fields we need from electron-builder's latest.yml. The file is
 * simple enough (flat keys plus one list) that a real YAML parser would be a
 * dependency for nothing; this reads the top-level `version:`/`path:`/
 * `sha512:` lines and ignores the rest.
 */
export function parseLatestYml(text: string): { version: string; path: string; sha512: string } | null {
  const top: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line) // top-level only: no leading indent
    if (m) top[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '')
  }
  if (!top.version || !top.path || !top.sha512) return null
  return { version: top.version, path: top.path, sha512: top.sha512 }
}

/** The bits of a GitHub Release asset we read. Everything else is ignored. */
interface ReleaseAsset {
  name: string
  size: number
  url: string
}

/**
 * Pull the newest installer and the latest.yml (if any) out of a
 * `GET /releases/latest` response. The JSON comes off the network, so every
 * field is checked rather than trusted.
 */
export function pickRelease(
  json: unknown,
  currentVersion: string
): { version: string; installer: ReleaseAsset; latestYmlUrl: string | null; releaseUrl: string } | null {
  if (!json || typeof json !== 'object') return null
  const rel = json as { draft?: unknown; prerelease?: unknown; assets?: unknown; html_url?: unknown }
  if (rel.draft === true || rel.prerelease === true || !Array.isArray(rel.assets)) return null

  let best: { version: string; installer: ReleaseAsset } | null = null
  let latestYmlUrl: string | null = null
  for (const a of rel.assets as unknown[]) {
    if (!a || typeof a !== 'object') continue
    const { name, size, browser_download_url: url } = a as Record<string, unknown>
    if (typeof name !== 'string' || typeof url !== 'string' || !/^https:\/\//i.test(url)) continue
    if (name === 'latest.yml') {
      latestYmlUrl = url
      continue
    }
    const version = parseInstallerName(name)
    if (!version || compareVersions(version, currentVersion) <= 0) continue
    if (!best || compareVersions(version, best.version) > 0) {
      best = { version, installer: { name, size: typeof size === 'number' ? size : 0, url } }
    }
  }
  if (!best) return null
  const releaseUrl = typeof rel.html_url === 'string' ? rel.html_url : RELEASES_PAGE
  return { ...best, latestYmlUrl, releaseUrl }
}

/** Same name modulo the space→dot rewrite GitHub applies to uploaded assets. */
function sameAssetName(a: string, b: string): boolean {
  const norm = (s: string): string => s.replace(/ /g, '.').toLowerCase()
  return norm(a) === norm(b)
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

// Electron's net.fetch rather than Node's: it goes through Chromium's network
// stack, so it honours the system proxy settings a company network needs.
const defaultFetch: FetchLike = (url, init) => net.fetch(url, init)

const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'baguette-updater'
}

/** Ask GitHub for a release newer than `currentVersion`. Never throws. */
export async function checkForUpdate(
  currentVersion: string,
  fetchImpl: FetchLike = defaultFetch
): Promise<UpdateCheckResult> {
  const base: UpdateCheckResult = {
    currentVersion,
    latestVersion: null,
    url: null,
    fileName: null,
    size: null,
    sha512: null,
    releaseUrl: RELEASES_PAGE,
    checkedAt: Date.now()
  }

  let json: unknown
  try {
    const res = await fetchImpl(LATEST_RELEASE_API, {
      headers: GITHUB_HEADERS,
      signal: AbortSignal.timeout(20_000)
    })
    // 404 here means "no published Release yet", not a broken URL.
    if (res.status === 404) return { ...base, error: 'GitHub 上還沒有發布任何 Release' }
    if (res.status === 403 || res.status === 429) {
      return { ...base, error: 'GitHub API 暫時限流（每小時 60 次），稍後再試' }
    }
    if (!res.ok) return { ...base, error: `GitHub 回應 HTTP ${res.status}` }
    json = await res.json()
  } catch (e) {
    return { ...base, error: `連不上 GitHub：${(e as Error).message}` }
  }

  const picked = pickRelease(json, currentVersion)
  if (!picked) return base

  // latest.yml carries a checksum for exactly one installer. Use it only when
  // it describes the one we picked — a stale latest.yml next to a newer
  // hand-uploaded installer must not fail the verify.
  let sha512: string | null = null
  if (picked.latestYmlUrl) {
    try {
      const res = await fetchImpl(picked.latestYmlUrl, {
        headers: { 'User-Agent': GITHUB_HEADERS['User-Agent'] },
        signal: AbortSignal.timeout(20_000)
      })
      const meta = res.ok ? parseLatestYml(await res.text()) : null
      if (meta && meta.version === picked.version && sameAssetName(meta.path, picked.installer.name)) {
        sha512 = meta.sha512
      }
    } catch (e) {
      log.warn(`update check: could not read latest.yml: ${(e as Error).message}`)
    }
  }

  return {
    ...base,
    latestVersion: picked.version,
    url: picked.installer.url,
    fileName: picked.installer.name,
    size: picked.installer.size || null,
    sha512,
    releaseUrl: picked.releaseUrl
  }
}

/**
 * Stream `url` into `dest`, hashing on the way. Returns the base64 sha512 and
 * the byte count. A partial file is removed on failure.
 */
async function download(url: string, dest: string, fetchImpl: FetchLike): Promise<{ sha512: string; bytes: number }> {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': GITHUB_HEADERS['User-Agent'] },
    signal: AbortSignal.timeout(15 * 60_000)
  })
  if (!res.ok || !res.body) throw new Error(`下載失敗：HTTP ${res.status}`)
  const hash = createHash('sha512')
  let bytes = 0
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk)
      bytes += chunk.length
      cb(null, chunk)
    }
  })
  try {
    await pipeline(Readable.fromWeb(res.body as unknown as NodeWebReadableStream), tap, createWriteStream(dest))
  } catch (e) {
    rmSync(dest, { force: true })
    throw new Error(`下載中斷：${(e as Error).message}`, { cause: e })
  }
  return { sha512: hash.digest('base64'), bytes }
}

/**
 * Download the installer, verify it, hand off to it, and quit. Rejects with a
 * user-facing message if anything before the hand-off fails; after the
 * hand-off there is no coming back.
 */
export async function installUpdate(result: UpdateCheckResult, fetchImpl: FetchLike = defaultFetch): Promise<void> {
  if (!result.url || !result.fileName || !result.latestVersion) throw new Error('沒有可安裝的更新')

  const stageDir = join(app.getPath('temp'), 'baguette-update')
  mkdirSync(stageDir, { recursive: true })
  // Only ever a name GitHub listed that also matched INSTALLER_RE, so it
  // cannot carry a path separator.
  const staged = join(stageDir, result.fileName)
  const got = await download(result.url, staged, fetchImpl)

  const fail = (message: string): never => {
    rmSync(staged, { force: true })
    throw new Error(message)
  }
  if (result.size && got.bytes !== result.size) fail(`下載的檔案大小不符（${got.bytes} / ${result.size} bytes），請再試一次`)
  if (got.bytes < 10 * 1024 * 1024) fail('安裝檔看起來不完整（小於 10 MB）')
  if (result.sha512 && got.sha512 !== result.sha512) fail('安裝檔校驗失敗（sha512 不符），請再試一次')

  log.info(`handing off to installer ${staged} (${result.currentVersion} -> ${result.latestVersion})`)
  // The same flags electron-updater passes: silent, mark as an update (the
  // NSIS script then waits for us to exit instead of prompting), relaunch
  // when done. Detached + unref so quitting this process doesn't take the
  // installer with it.
  const child = spawn(staged, ['/S', '--updated', '--force-run'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  child.unref()
  // Give the installer a moment to start before our before-quit kills the
  // ptys and the window goes away; it then sees us exit on its own.
  setTimeout(() => app.quit(), 500)
}
