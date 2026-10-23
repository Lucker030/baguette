import { statSync } from 'node:fs'
import { execFile, execFileSync } from 'node:child_process'
import { join, delimiter } from 'node:path'
import os from 'node:os'
import type { Provider, ProviderMeta } from '../shared/types'
import { describeError, log } from './log'

/** True only for something Windows/POSIX could actually execute. */
function isExecutableFile(path: string): boolean {
  try {
    // existsSync alone also matches directories, so a folder named `python`
    // anywhere on PATH would shadow the real interpreter.
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Minimal cross-platform `which`: resolve an executable name against PATH.
 *
 * On Windows the PATHEXT variants are tried BEFORE the bare name. npm installs
 * a global CLI as three files side by side — `codex` (a POSIX sh shim),
 * `codex.cmd` and `codex.ps1` — and Windows can only run the `.cmd`. Preferring
 * the bare name returns the sh shim, which then fails to spawn while
 * `listProviders()` still reports the provider as available, and because the
 * lookup "succeeded" both the well-known-location and WSL fallbacks are
 * skipped. cmd.exe itself only ever runs PATHEXT extensions.
 */
export function which(cmd: string): string | undefined {
  const isWin = process.platform === 'win32'
  const exts = isWin
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase())
    : []
  const candidates = isWin ? [...exts, ''] : ['']
  const paths = (process.env.PATH || '').split(delimiter)
  for (const p of paths) {
    if (!p) continue
    for (const ext of candidates) {
      const full = join(p, cmd + ext)
      if (isExecutableFile(full)) return full
    }
  }
  return undefined
}

/** Extra well-known install locations to probe when a binary is not on PATH. */
function extraLocations(id: Provider): string[] {
  const home = os.homedir()
  if (id === 'copilot') {
    return [
      join(home, 'AppData', 'Local', 'GitHubCopilotCLI', 'copilot.exe'),
      join(home, '.local', 'bin', 'copilot')
    ]
  }
  if (id === 'codex') {
    return [
      join(home, 'AppData', 'Roaming', 'npm', 'codex.cmd'),
      join(home, 'AppData', 'Roaming', 'npm', 'codex'),
      join(home, '.local', 'bin', 'codex.exe'),
      join(home, '.local', 'bin', 'codex')
    ]
  }
  if (id === 'claude') {
    return [
      join(home, '.local', 'bin', 'claude.exe'),
      join(home, '.local', 'bin', 'claude'),
      join(home, 'AppData', 'Local', 'Programs', 'claude', 'claude.exe'),
      join(home, '.claude', 'local', 'claude.exe')
    ]
  }
  return []
}

export interface ResolvedProvider {
  command: string
  args: string[]
}

// --- WSL fallback for `claude`: this machine has no native Windows install,
// only the one inside its WSL distro. Reuse that instead of requiring a
// second, separate install just for this app. ------------------------------

function wslExePath(): string | undefined {
  return process.platform === 'win32' ? which('wsl') : undefined
}

let wslClaudeCache: boolean | null = null

/**
 * Probes once per command (cheap, cached) whether the default WSL distro has a
 * given binary on its PATH. Must go through a login+interactive bash (`-lic`),
 * not `--exec`: `--exec` bypasses shell startup entirely, so PATH additions from
 * `.profile`/`.bashrc` (e.g. `~/.local/bin`, nvm) are invisible and the probe
 * always fails even when the binary is genuinely installed.
 */
const wslCmdCache: Record<string, boolean> = {}
function wslHasCmd(cmd: string): boolean {
  if (cmd in wslCmdCache) return wslCmdCache[cmd]
  const wsl = wslExePath()
  if (!wsl) return (wslCmdCache[cmd] = false)
  try {
    execFileSync(wsl, ['--', 'bash', '-lic', `command -v ${cmd}`], {
      timeout: 5000,
      windowsHide: true,
      stdio: 'ignore'
    })
    wslCmdCache[cmd] = true
  } catch {
    wslCmdCache[cmd] = false
  }
  return wslCmdCache[cmd]
}

/**
 * Async twin of wslHasCmd, used by the startup probe.
 *
 * The sync version blocks the main process for up to 5 s per command, and
 * listProviders() probes two — so a cold WSL made the whole app unresponsive
 * (no IPC, no pty output, no paint) for up to 10 s right at launch. Populating
 * the same cache off the event loop keeps the window alive; every later
 * lookup is a cache hit and stays synchronous.
 */
function wslHasCmdAsync(cmd: string): Promise<boolean> {
  if (cmd in wslCmdCache) return Promise.resolve(wslCmdCache[cmd])
  const wsl = wslExePath()
  if (!wsl) {
    log.warn(`WSL probe for ${cmd}: wsl.exe not found on PATH`)
    return Promise.resolve((wslCmdCache[cmd] = false))
  }
  return new Promise((resolve) => {
    execFile(
      wsl,
      ['--', 'bash', '-lic', `command -v ${cmd}`],
      // 20 s, not 5: this runs once at launch, and the first wsl.exe call after
      // boot has to start the distro's VM, which on a fresh machine easily
      // takes longer than 5 s. A timeout is cached as "not installed" for the
      // whole run, so a short cap made claude/codex show as 未偵測到 until
      // the app was restarted. Being async, the longer wait blocks nothing.
      { timeout: 20000, windowsHide: true },
      (err, stdout, stderr) => {
        // Logged because "未偵測到" alone says nothing about why: the same
        // command can succeed in the user's terminal and fail from the app.
        if (err) {
          log.warn(
            `WSL probe for ${cmd} failed via ${wsl}: ${describeError(err)}` +
              ` | stdout=${JSON.stringify(String(stdout).slice(0, 300))}` +
              ` | stderr=${JSON.stringify(String(stderr).slice(0, 300))}`
          )
        } else {
          log.info(`WSL probe for ${cmd}: ${String(stdout).trim()}`)
        }
        resolve((wslCmdCache[cmd] = !err))
      }
    )
  })
}

/**
 * Warm the WSL probe cache without blocking. Call before listProviders() so
 * that it can answer entirely from cache.
 */
export async function warmProviderCache(): Promise<void> {
  if (process.platform !== 'win32') return
  const needed: string[] = []
  if (!resolveNativeClaude()) needed.push('claude')
  if (!which('codex') && !extraLocations('codex').some(isExecutableFile)) needed.push('codex')
  await Promise.all(needed.map((cmd) => wslHasCmdAsync(cmd)))
  if ('claude' in wslCmdCache) wslClaudeCache = wslCmdCache['claude']
  // Same trip into WSL, same warm-it-off-the-event-loop reason: creating a
  // Claude session needs this to locate its transcript directory (see
  // claudeProjectDirectory), and probing it lazily on the first session
  // would pay the cold-WSL cost right when the user is waiting on a tab.
  if (wslClaudeCache) await wslHomeUncPathAsync()
}

function wslHasClaude(): boolean {
  if (wslClaudeCache !== null) return wslClaudeCache
  return (wslClaudeCache = wslHasCmd('claude'))
}

/** `C:\Users\X\Y` -> `/mnt/c/Users/X/Y`, as seen from inside WSL. */
export function toWslPath(winPath: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath)
  if (!m) return winPath
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`
}

function resolveNativeClaude(): ResolvedProvider | null {
  const onPath = which('claude')
  if (onPath) return { command: onPath, args: [] }
  for (const loc of extraLocations('claude')) {
    if (isExecutableFile(loc)) return { command: loc, args: [] }
  }
  return null
}

/**
 * Resolve how to actually launch a claude session for a given cwd/account.
 * Prefers a native Windows install; falls back to invoking the WSL install
 * via `wsl.exe --cd <dir> -- env CLAUDE_CONFIG_DIR=<dir> bash -lic "exec claude"`.
 *
 * Two non-obvious constraints, both verified empirically against this app's
 * actual WSL distro:
 * - Must run through `bash -lic`, not `--exec`, so `.profile`/`.bashrc` PATH
 *   additions (`~/.local/bin`, nvm) are in effect — see wslHasClaude().
 * - The `-lic` payload string must never contain a literal `$VAR` reference.
 *   wsl.exe reconstructs the non-`--exec` command line and re-parses it
 *   through a shell before the login bash (and its `env VAR=x` prefix) ever
 *   runs, so any `$VAR` in that string expands too early against an
 *   environment that doesn't have it yet, silently resolving to empty. A
 *   literal payload like `exec claude` has nothing to prematurely expand, so
 *   the `env`-set CLAUDE_CONFIG_DIR survives untouched into the real process.
 */
export function resolveClaudeLaunch(
  cwd: string,
  claudeConfigDir?: string,
  extraArgs: string[] = []
): ResolvedProvider | null {
  const native = resolveNativeClaude()
  if (native) return { command: native.command, args: [...native.args, ...extraArgs] }
  if (!wslHasClaude()) return null
  const wsl = wslExePath()!
  const args = ['--cd', toWslPath(cwd), '--']
  if (claudeConfigDir) args.push('env', `CLAUDE_CONFIG_DIR=${toWslPath(claudeConfigDir)}`)
  // extraArgs are literal flags/UUIDs (no `$`, no shell metachars), so folding
  // them into the exec payload is safe under the -lic re-parse (see above).
  args.push('bash', '-lic', wslExec('claude', extraArgs))
  return { command: wsl, args }
}

/** True when a claude session actually launches through the WSL fallback (this machine has no native install). */
export function claudeUsesWsl(): boolean {
  return !resolveNativeClaude() && wslHasClaude()
}

let wslHomeUncCache: string | null | undefined // undefined = not probed yet, null = probe failed

/**
 * Windows UNC path to the WSL distro's Linux $HOME (e.g.
 * `\\wsl.localhost\Ubuntu\home\ethanlin`), used to find the default Claude
 * account's `~/.claude/projects/...` from the Windows side. Resolved via
 * `wslpath -w`, which picks the right distro automatically — sidesteps ever
 * having to know or hardcode the distro's name.
 *
 * Async and timeout-capped for the same reason wslHasCmdAsync exists: this
 * is reached from the session-creation path, and a synchronous WSL call
 * against a cold distro blocks the main process outright (no IPC, no pty
 * output, no paint) for as long as it takes to start. warmProviderCache()
 * pre-populates this, so in practice it is a cache hit by the time any
 * session is created.
 */
function wslHomeUncPathAsync(): Promise<string | null> {
  if (wslHomeUncCache !== undefined) return Promise.resolve(wslHomeUncCache)
  const wsl = wslExePath()
  if (!wsl) return Promise.resolve((wslHomeUncCache = null))
  return new Promise((resolve) => {
    execFile(
      wsl,
      ['--', 'bash', '-lic', 'wslpath -w "$HOME"'],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => resolve((wslHomeUncCache = err ? null : stdout.trim() || null))
    )
  })
}

/**
 * Claude Code's own project-directory naming: the absolute path as seen from
 * wherever claude actually runs, with every character that isn't an ASCII
 * letter or digit — including the `/` separators themselves — replaced by a
 * literal `-`, with no collapsing of runs. Verified empirically against this
 * app's actual WSL distro (a cwd with CJK characters and underscores in it
 * confirmed the rule: each such character becomes its own `-`).
 */
export function claudeProjectDirName(claudeSideCwd: string): string {
  return claudeSideCwd.replace(/[^A-Za-z0-9]/g, '-')
}

/**
 * The Windows-accessible folder holding this cwd's session transcripts
 * (`<uuid>.jsonl` files), or null if it can't be determined — e.g. not
 * running via the WSL fallback, or the WSL home-dir probe failed. Callers
 * must treat null (and a directory that doesn't exist yet) as "can't
 * discover the session id yet," not an error — see pty-manager.ts.
 */
export async function claudeProjectDirectory(
  cwd: string,
  claudeConfigDir?: string
): Promise<string | null> {
  if (!claudeUsesWsl()) return null
  // The project-directory name is always derived from the working directory,
  // regardless of which CLAUDE_CONFIG_DIR (account) is active.
  const dirName = claudeProjectDirName(toWslPath(cwd))
  if (claudeConfigDir) {
    // Custom accounts already live at a plain Windows path (see
    // resolveClaudeLaunch), so no WSL probe is needed to reach them —
    // CLAUDE_CONFIG_DIR/projects/<dirName>. Verified against this machine's
    // real account dirs, which do use exactly this layout and naming.
    return join(claudeConfigDir, 'projects', dirName)
  }
  const home = await wslHomeUncPathAsync()
  if (!home) return null
  return join(home, '.claude', 'projects', dirName)
}

/**
 * Where Claude Code keeps this account's OAuth tokens, as a path the Windows
 * side can stat — or null when it can't be located. Custom accounts live at a
 * plain Windows path already; the default account's `~/.claude` is inside the
 * WSL distro and is reached over `\\wsl.localhost\...` like the transcripts.
 * The native Windows CLI may keep tokens elsewhere (Credential Manager), in
 * which case the file simply never appears and nothing watches it.
 */
export async function claudeCredentialsPath(claudeConfigDir?: string): Promise<string | null> {
  if (claudeConfigDir) return join(claudeConfigDir, '.credentials.json')
  if (!claudeUsesWsl()) return join(os.homedir(), '.claude', '.credentials.json')
  const home = await wslHomeUncPathAsync()
  if (!home) return null
  return join(home, '.claude', '.credentials.json')
}

/** Wrap a token so bash treats it as one literal word, whatever it contains. */
function shellQuote(token: string): string {
  return `'${token.replace(/'/g, `'\\''`)}'`
}

/**
 * Build a `-lic` exec payload: `exec <cmd> <extraArgs...>`.
 *
 * Unlike the surrounding argv entries (`--cd <path>`, `env VAR=<path>`), which
 * wsl.exe hands through verbatim, this string is handed to `bash -c` and is
 * therefore parsed as shell source — verified: a payload of
 * `echo $(id -u)` really does substitute. extraArgs can carry a session id
 * that originated in the renderer, so every token is quoted rather than
 * trusting a comment that says they only ever hold literal flags.
 */
function wslExec(cmd: string, extraArgs: string[]): string {
  if (!extraArgs.length) return `exec ${cmd}`
  return `exec ${cmd} ${extraArgs.map(shellQuote).join(' ')}`
}

/**
 * Resolve how to launch a ChatGPT (OpenAI Codex CLI) session for a given cwd.
 * Mirrors resolveClaudeLaunch: prefer a native Windows `codex`, else fall back
 * to the WSL install via `wsl.exe --cd <dir> -- bash -lic "exec codex ..."`.
 * Codex has no per-account config-dir mechanism, so nothing is injected —
 * logging in / out happens inside the CLI itself (its own `/login`).
 * `extraArgs` carries resume flags, e.g. `['resume', '--last']`.
 */
export function resolveCodexLaunch(cwd: string, extraArgs: string[] = []): ResolvedProvider | null {
  const onPath = which('codex')
  if (onPath) return { command: onPath, args: [...extraArgs] }
  for (const loc of extraLocations('codex')) {
    if (isExecutableFile(loc)) return { command: loc, args: [...extraArgs] }
  }
  if (!wslHasCmd('codex')) return null
  const wsl = wslExePath()!
  return { command: wsl, args: ['--cd', toWslPath(cwd), '--', 'bash', '-lic', wslExec('codex', extraArgs)] }
}

/** Resolve the launch command for a provider, or null when unavailable. */
export function resolveProvider(id: Provider): ResolvedProvider | null {
  if (id === 'shell') {
    const pwsh = which('pwsh') || which('powershell')
    if (pwsh) return { command: pwsh, args: ['-NoLogo'] }
    const cmd = process.env.COMSPEC || which('cmd')
    return cmd ? { command: cmd, args: [] } : null
  }


  if (id === 'claude') {
    const native = resolveNativeClaude()
    if (native) return native
    if (wslHasClaude()) return { command: wslExePath()!, args: ['--', 'bash', '-lic', 'exec claude'] }
    return null
  }

  if (id === 'codex') {
    const onPath = which('codex')
    if (onPath) return { command: onPath, args: [] }
    for (const loc of extraLocations('codex')) {
      if (isExecutableFile(loc)) return { command: loc, args: [] }
    }
    if (wslHasCmd('codex')) return { command: wslExePath()!, args: ['--', 'bash', '-lic', 'exec codex'] }
    return null
  }

  const onPath = which(id)
  if (onPath) return { command: onPath, args: [] }
  for (const loc of extraLocations(id)) {
    if (isExecutableFile(loc)) return { command: loc, args: [] }
  }
  return null
}


const LABELS: Record<Provider, string> = {
  claude: 'Claude',
  codex: 'ChatGPT',
  copilot: 'Copilot',
  shell: 'Shell'
}

const HINTS: Record<Provider, string> = {
  claude: '找不到 claude CLI，請確認已安裝 Claude Code 並在 PATH 中。',
  codex: '找不到 codex CLI（ChatGPT），請先安裝 OpenAI Codex CLI（npm i -g @openai/codex）並在 PATH 中。',
  copilot: '找不到 copilot CLI，請確認已安裝 GitHub Copilot CLI。',
  shell: '找不到可用的 shell（pwsh / powershell / cmd）。'
}

/** Metadata for every provider, including live availability detection. */
export function listProviders(): ProviderMeta[] {
  return (['claude', 'codex', 'copilot', 'shell'] as Provider[]).map((id) => {
    const resolved = resolveProvider(id)
    log.info(`provider ${id}: ${resolved ? `${resolved.command} ${resolved.args.join(' ')}`.trim() : 'not found'}`)
    return {
      id,
      label: LABELS[id],
      available: resolved !== null,
      command: resolved?.command,
      hint: resolved ? undefined : HINTS[id]
    }
  })
}
