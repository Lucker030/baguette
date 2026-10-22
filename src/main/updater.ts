import { app } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { UpdateCheckResult } from '../shared/types'
import { log } from './log'

// Updates from a folder instead of a server.
//
// There is no online feed for this app and no plan for one — the build sits
// in release/ on the developer's machine, or on a share. What the user wanted
// was the *experience* of auto-update (a "new version" notice, one click to
// install, come back on the new build) pointed at that folder. So this does
// what electron-updater's generic provider would do against an HTTP feed,
// against a directory:
//
//   1. list `Local Platform Setup <ver>.exe` files, pick the newest one that
//      is newer than the running build;
//   2. if the folder also has electron-builder's latest.yml, take the sha512
//      from it and verify the installer after copying — a share can hand you
//      a half-written file;
//   3. copy the installer to a local temp path (the share may vanish mid-
//      install), launch it silently with the same flags electron-updater
//      uses, and quit. The NSIS script waits for this process to exit, kills
//      it if it doesn't, installs, and relaunches the app (`--force-run`).

const INSTALLER_RE = /^Local Platform Setup (\d+)\.(\d+)\.(\d+)\.exe$/i

/** `'Local Platform Setup 0.27.0.exe'` → `'0.27.0'`, or null for anything else. */
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

/** Scan `dir` for an installer newer than `currentVersion`. Never throws. */
export function checkForUpdate(dir: string, currentVersion: string): UpdateCheckResult {
  const base: UpdateCheckResult = {
    currentVersion,
    latestVersion: null,
    file: null,
    sha512: null,
    checkedAt: Date.now()
  }
  if (!dir) return { ...base, error: '尚未設定更新來源資料夾' }

  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (e) {
    return { ...base, error: `讀不到資料夾：${(e as Error).message}` }
  }

  let best: { version: string; name: string } | null = null
  for (const name of names) {
    const version = parseInstallerName(name)
    if (!version) continue
    if (compareVersions(version, currentVersion) <= 0) continue
    if (!best || compareVersions(version, best.version) > 0) best = { version, name }
  }
  if (!best) return base

  // latest.yml, when present, carries a checksum for exactly one installer.
  // Use it only when it describes the one we picked — a stale latest.yml
  // next to a newer hand-copied installer must not fail the verify.
  let sha512: string | null = null
  try {
    const meta = parseLatestYml(readFileSync(join(dir, 'latest.yml'), 'utf8'))
    if (meta && meta.version === best.version && basename(meta.path) === best.name) sha512 = meta.sha512
  } catch {
    /* no latest.yml — older release folder; proceed without verification */
  }

  return { ...base, latestVersion: best.version, file: join(dir, best.name), sha512 }
}

function sha512Base64(file: string): string {
  return createHash('sha512').update(readFileSync(file)).digest('base64')
}

/**
 * Copy the installer locally, verify it when we can, hand off to it, and quit.
 * Throws with a user-facing message if anything before the hand-off fails;
 * after the hand-off there is no coming back.
 */
export function installUpdate(result: UpdateCheckResult): void {
  if (!result.file || !result.latestVersion) throw new Error('沒有可安裝的更新')
  const size = statSync(result.file).size
  if (size < 10 * 1024 * 1024) throw new Error('安裝檔看起來不完整（小於 10 MB），可能還在複製中')

  const stageDir = join(app.getPath('temp'), 'dashboard-update')
  mkdirSync(stageDir, { recursive: true })
  const staged = join(stageDir, basename(result.file))
  copyFileSync(result.file, staged)

  if (result.sha512) {
    const actual = sha512Base64(staged)
    if (actual !== result.sha512) {
      throw new Error('安裝檔校驗失敗（sha512 不符），可能是複製到一半的檔案，請稍後再試')
    }
  }

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
