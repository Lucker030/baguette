import { statSync } from 'node:fs'
import { execFile, execFileSync } from 'node:child_process'
import { join, delimiter } from 'node:path'
import os from 'node:os'
import type { Provider, ProviderMeta, Runtime, RuntimePref } from '../shared/types'
import { PROVIDERS } from '../shared/types'
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
 * Expand `%VAR%` references the way Windows does for REG_EXPAND_SZ values;
 * unknown variables are left as written.
 */
export function expandWinEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
    return key ? (env[key] ?? whole) : whole
  })
}

/** The `Path` value out of `reg query <key> /v Path` output, or '' if absent. */
export function parseRegQueryPath(output: string): string {
  const m = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(output)
  return m ? m[1].trim() : ''
}

let registryPathCache: { at: number; dirs: string[] } | null = null

/**
 * The user + machine PATH as Windows has them *now*, from the registry.
 *
 * This process's own PATH is a snapshot from when the app started. A CLI
 * installed while the app is running (verified: Codex's installer adds
 * `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` to the user PATH; agy's adds
 * `%LOCALAPPDATA%\agy\bin`) would otherwise stay "未偵測到" until the app is
 * restarted. Cached briefly — listProviders calls which() several times.
 */
function registryPath(): string[] {
  if (process.platform !== 'win32') return []
  if (registryPathCache && Date.now() - registryPathCache.at < 10_000) return registryPathCache.dirs
  const read = (key: string): string => {
    try {
      return parseRegQueryPath(
        execFileSync('reg', ['query', key, '/v', 'Path'], { encoding: 'utf8', timeout: 3000, windowsHide: true })
      )
    } catch {
      return '' // no such value (a user without a PATH of their own) or reg unavailable
    }
  }
  const raw = [
    read('HKCU\\Environment'),
    read('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment')
  ].join(';')
  const dirs = raw
    .split(';')
    .map((d) => expandWinEnv(d.trim()))
    .filter(Boolean)
  registryPathCache = { at: Date.now(), dirs }
  return dirs
}

/**
 * Minimal cross-platform `which`: resolve an executable name against PATH
 * (this process's, plus on Windows the registry's current one — see
 * registryPath).
 *
 * On Windows only PATHEXT variants count. npm installs a global CLI as three
 * files side by side — `codex` (a POSIX sh shim), `codex.cmd` and `codex.ps1`
 * — and Windows can only run the `.cmd`. Returning the bare name hands back
 * the sh shim, which then fails to spawn while `listProviders()` still
 * reports the provider as available, and because the lookup "succeeded" both
 * the well-known-location and WSL fallbacks are skipped. cmd.exe itself only
 * ever runs PATHEXT extensions.
 */
export function which(cmd: string): string | undefined {
  const isWin = process.platform === 'win32'
  const candidates = isWin
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase())
    : ['']
  const paths = [...new Set([...(process.env.PATH || '').split(delimiter), ...registryPath()])]
  for (const p of paths) {
    if (!p) continue
    for (const ext of candidates) {
      const full = join(p, cmd + ext)
      if (isExecutableFile(full)) return full
    }
  }
  return undefined
}

// ---- Windows installs ---------------------------------------------------------

/** The executable each provider runs as, on Windows and inside WSL. */
const CLI_NAMES: Record<Exclude<Provider, 'shell'>, string> = {
  claude: 'claude',
  codex: 'codex',
  copilot: 'copilot',
  antigravity: 'agy'
}

export function cliName(id: Exclude<Provider, 'shell'>): string {
  return CLI_NAMES[id]
}

/**
 * Install locations probed when a binary is not on PATH — the official
 * installers first, then every package manager's global bin dir. Normally
 * these dirs are on PATH anyway; listing them covers a PATH that was never
 * updated (a portable install, an installer run with PATH changes declined).
 * Only Windows-runnable names: a bare `codex` next to `codex.cmd` is npm's sh
 * shim (see which()).
 */
export function extraLocations(id: Exclude<Provider, 'shell'>, home = os.homedir(), env = process.env): string[] {
  const appData = env.APPDATA || join(home, 'AppData', 'Roaming')
  const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local')
  const name = CLI_NAMES[id]

  const official: Record<Exclude<Provider, 'shell'>, string[]> = {
    claude: [
      join(home, '.local', 'bin', 'claude.exe'), // native installer
      join(local, 'Programs', 'claude', 'claude.exe'),
      join(home, '.claude', 'local', 'claude.exe') // older "local" install
    ],
    codex: [join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')],
    copilot: [join(local, 'GitHubCopilotCLI', 'copilot.exe')],
    antigravity: [join(local, 'agy', 'bin', 'agy.exe')]
  }

  const managerDirs = [
    join(appData, 'npm'), // npm i -g
    env.PNPM_HOME || join(local, 'pnpm'), // pnpm add -g
    join(env.BUN_INSTALL || join(home, '.bun'), 'bin'), // bun add -g
    join(local, 'Volta', 'bin'), // volta install
    join(env.SCOOP || join(home, 'scoop'), 'shims'), // scoop install
    join(local, 'Microsoft', 'WinGet', 'Links'), // winget (portable packages)
    join(home, '.local', 'bin')
  ]
  const managed = managerDirs.flatMap((dir) => ['.exe', '.cmd'].map((ext) => join(dir, name + ext)))

  return [...new Set([...official[id], ...managed])]
}

/** The Windows install of a provider, if there is one. */
function windowsCommand(id: Provider): string | undefined {
  if (id === 'shell') return which('pwsh') || which('powershell') || process.env.COMSPEC || which('cmd')
  return which(CLI_NAMES[id]) ?? extraLocations(id).find(isExecutableFile)
}

export interface ResolvedProvider {
  command: string
  args: string[]
}

// ---- WSL installs ----------------------------------------------------------------

function wslExePath(): string | undefined {
  return process.platform === 'win32' ? which('wsl') : undefined
}

/**
 * How long a WSL probe may take. WSL stops the distro shortly after its last
 * process exits, so the probe at every app launch is a cold start — measured
 * 2.3–3.3 s on an idle machine with a systemd distro, and it runs while
 * Electron itself is starting. The old 5 s cap regularly expired, and the
 * timeout was then cached as "claude is not installed" for the whole run.
 * The async probe doesn't block anything, so be generous; the renderer shows
 * 偵測中 meanwhile.
 */
const WSL_PROBE_TIMEOUT_MS = 30_000

/** Printed after the lookups, so a reply that contains it is a complete answer. */
const WSL_PROBE_DONE = '__baguette_probe_done__'

/**
 * One trip into WSL answers for every CLI at once:
 * `command -v claude codex copilot agy; echo <marker>`.
 *
 * Must go through a login+interactive bash (`-lic`), not `--exec`: `--exec`
 * bypasses shell startup entirely, so PATH additions from `.profile`/`.bashrc`
 * (`~/.local/bin`, nvm) are invisible and the probe always fails even when the
 * binary is genuinely installed. The payload contains no `$` — see
 * resolveLaunch for why a `-lic` payload must never reference a variable.
 */
function wslProbeArgs(): string[] {
  return ['--', 'bash', '-lic', `command -v ${Object.values(CLI_NAMES).join(' ')}; echo ${WSL_PROBE_DONE}`]
}

/**
 * Which CLIs a probe found, or null when the reply is not a complete answer
 * (timed out, WSL failed to start, no distro). `command -v` prints a path
 * per found command (or just the name for an alias/function) and nothing for
 * a missing one; it exits 1 if any is missing, which is why the marker — not
 * the exit status — decides whether the answer is complete.
 */
export function parseWslProbe(stdout: string): Set<string> | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim())
  const end = lines.indexOf(WSL_PROBE_DONE)
  if (end === -1) return null
  const names = new Set(Object.values(CLI_NAMES))
  const found = new Set<string>()
  for (const line of lines.slice(0, end)) {
    const base = line.split('/').pop() ?? ''
    if (names.has(base)) found.add(base)
  }
  return found
}

/**
 * The last complete probe: which CLIs WSL has, and that WSL itself works
 * (needed for a WSL shell tab). null = not known yet; an incomplete probe is
 * never stored, so the next caller asks again instead of the provider staying
 * "未偵測到" until the app restarts.
 */
let wslState: { usable: boolean; found: Set<string> } | null = null
let wslInflight: Promise<void> | null = null

/**
 * Logged either way because "未偵測到" alone says nothing about why: the same
 * command can succeed in the user's terminal and fail from the app.
 */
function settleWsl(stdout: string, err: unknown, stderr = ''): void {
  const found = parseWslProbe(stdout)
  if (found) {
    wslState = { usable: true, found }
    log.info(`WSL probe: found ${[...found].join(', ') || 'none of the CLIs'}`)
  } else {
    log.warn(
      `WSL probe got no complete answer, will retry: ${err ? describeError(err) : 'no end marker'}` +
        ` | stdout=${JSON.stringify(stdout.slice(0, 300))} | stderr=${JSON.stringify(stderr.slice(0, 300))}`
    )
  }
}

/** Probe WSL off the event loop. Concurrent callers share one trip. */
function probeWslAsync(): Promise<void> {
  if (wslState) return Promise.resolve()
  if (wslInflight) return wslInflight
  const wsl = wslExePath()
  if (!wsl) {
    log.warn('WSL probe: wsl.exe not found on PATH')
    wslState = { usable: false, found: new Set() }
    return Promise.resolve()
  }
  wslInflight = new Promise<void>((resolve) => {
    execFile(wsl, wslProbeArgs(), { timeout: WSL_PROBE_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      wslInflight = null
      settleWsl(String(stdout ?? ''), err, String(stderr ?? ''))
      resolve()
    })
  })
  return wslInflight
}

/**
 * Synchronous fallback for a caller that didn't await warmProviderCache().
 * Short cap, because it blocks the main process.
 */
function probeWslSync(): void {
  if (wslState) return
  const wsl = wslExePath()
  if (!wsl) {
    wslState = { usable: false, found: new Set() }
    return
  }
  try {
    settleWsl(execFileSync(wsl, wslProbeArgs(), { encoding: 'utf8', timeout: 5000, windowsHide: true }), null)
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown }
    settleWsl(String(e.stdout ?? ''), err, String(e.stderr ?? ''))
  }
}

/** Whether WSL has `id` (or, for 'shell', whether WSL works at all). */
function wslHas(id: Provider): boolean {
  probeWslSync()
  if (!wslState) return false
  return id === 'shell' ? wslState.usable : wslState.found.has(CLI_NAMES[id])
}

/** Same, but null while no complete probe has come back yet (for display). */
function wslKnown(id: Provider): boolean | null {
  if (!wslState) return null
  return id === 'shell' ? wslState.usable : wslState.found.has(CLI_NAMES[id])
}

/**
 * Warm the WSL probe without blocking. Call before listProviders() — and
 * before creating a session — so they can answer entirely from cache. Always
 * probes (even when every CLI has a Windows install) because 設定 shows both
 * columns and a provider can be set to WSL-only.
 */
export async function warmProviderCache(): Promise<void> {
  if (process.platform !== 'win32') return
  await probeWslAsync()
  // Creating a Claude session needs this to locate its transcript directory
  // (see claudeProjectDirectory); probing it lazily on the first session
  // would pay the cold-WSL cost right when the user is waiting on a tab.
  if (claudeUsesWsl()) await wslHomeUncPathAsync()
}

// ---- Choosing between them ---------------------------------------------------------

let runtimePrefs: Partial<Record<Provider, RuntimePref>> = {}

/** Called by main with settings.runtimePrefs at startup and on every change. */
export function setRuntimePrefs(prefs: Partial<Record<Provider, RuntimePref>>): void {
  runtimePrefs = { ...prefs }
}

function prefOf(id: Provider): RuntimePref {
  return runtimePrefs[id] ?? 'auto'
}

/**
 * The runtime a new session uses: Windows when installed there (unless the
 * preference is WSL-only), else WSL when it has it (unless Windows-only).
 */
export function pickRuntime(pref: RuntimePref, hasWindows: boolean, hasWsl: () => boolean): Runtime | null {
  if (pref !== 'wsl' && hasWindows) return 'windows'
  if (pref !== 'windows' && hasWsl()) return 'wsl'
  return null
}

function chooseRuntime(id: Provider): { runtime: 'windows'; command: string } | { runtime: 'wsl' } | null {
  const native = prefOf(id) === 'wsl' ? undefined : windowsCommand(id)
  const runtime = pickRuntime(prefOf(id), !!native, () => wslHas(id))
  if (runtime === 'windows') return { runtime, command: native! }
  if (runtime === 'wsl') return { runtime }
  return null
}

/** `C:\Users\X\Y` -> `/mnt/c/Users/X/Y`, as seen from inside WSL. */
export function toWslPath(winPath: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath)
  if (!m) return winPath
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`
}

/**
 * Resolve how to launch a session of `id` in `cwd`, honouring the runtime
 * preference. `extraArgs` carries resume flags (`--continue`,
 * `['resume', '--last']`, ...). `accountEnv` names the CLI's config-dir
 * variable (CLAUDE_CONFIG_DIR, CODEX_HOME, COPILOT_HOME) and the account
 * folder: a Windows launch gets it through the pty's env (see pty-manager); a
 * WSL launch needs it passed explicitly, as a WSL path, because Windows env
 * vars don't cross into the distro:
 * `wsl.exe --cd <dir> -- env VAR=<dir> bash -lic "exec <cli> ..."`.
 *
 * Two non-obvious constraints, both verified empirically against this app's
 * actual WSL distro:
 * - Must run through `bash -lic`, not `--exec`, so `.profile`/`.bashrc` PATH
 *   additions (`~/.local/bin`, nvm) are in effect.
 * - The `-lic` payload string must never contain a literal `$VAR` reference.
 *   wsl.exe reconstructs the non-`--exec` command line and re-parses it
 *   through a shell before the login bash (and its `env VAR=x` prefix) ever
 *   runs, so any `$VAR` in that string expands too early against an
 *   environment that doesn't have it yet, silently resolving to empty. A
 *   literal payload like `exec claude` has nothing to prematurely expand, so
 *   the `env`-set variable survives untouched into the real process.
 *
 * A WSL shell tab is `wsl.exe --cd <dir>`: the distro's own default shell.
 */
export function resolveLaunch(
  id: Provider,
  cwd: string,
  extraArgs: string[] = [],
  accountEnv?: { name: string; dir: string }
): ResolvedProvider | null {
  const choice = chooseRuntime(id)
  if (!choice) return null
  if (choice.runtime === 'windows') {
    if (id === 'shell') return { command: choice.command, args: /pwsh|powershell/i.test(choice.command) ? ['-NoLogo'] : [] }
    return { command: choice.command, args: [...extraArgs] }
  }
  const wsl = wslExePath()!
  const args = ['--cd', toWslPath(cwd)]
  if (id === 'shell') return { command: wsl, args }
  args.push('--')
  if (accountEnv) args.push('env', `${accountEnv.name}=${toWslPath(accountEnv.dir)}`)
  args.push('bash', '-lic', wslExec(CLI_NAMES[id], extraArgs))
  return { command: wsl, args }
}

/** Claude's launch — see resolveLaunch. */
export function resolveClaudeLaunch(
  cwd: string,
  claudeConfigDir?: string,
  extraArgs: string[] = []
): ResolvedProvider | null {
  return resolveLaunch(
    'claude',
    cwd,
    extraArgs,
    claudeConfigDir ? { name: 'CLAUDE_CONFIG_DIR', dir: claudeConfigDir } : undefined
  )
}

/** True when a new claude session launches inside WSL. */
export function claudeUsesWsl(): boolean {
  return chooseRuntime('claude')?.runtime === 'wsl'
}

// ---- Claude-in-WSL specifics -----------------------------------------------------

let wslHomeUncCache: string | null | undefined // undefined = not probed yet, null = probe failed

/**
 * Windows UNC path to the WSL distro's Linux $HOME (e.g.
 * `\\wsl.localhost\Ubuntu\home\ethanlin`), used to find the default Claude
 * account's `~/.claude/projects/...` from the Windows side. Resolved via
 * `wslpath -w`, which picks the right distro automatically — sidesteps ever
 * having to know or hardcode the distro's name.
 *
 * Async and timeout-capped for the same reason probeWslAsync exists: this
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
      { timeout: WSL_PROBE_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        const home = err ? null : stdout.trim() || null
        // A failed probe is left uncached (undefined) so the next caller retries.
        if (home) wslHomeUncCache = home
        resolve(home)
      }
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
 * (`<uuid>.jsonl` files), or null if it can't be determined — e.g. the WSL
 * home-dir probe failed. Callers must treat null
 * (and a directory that doesn't exist yet) as "can't discover the session id
 * yet," not an error — see pty-manager.ts.
 */
export async function claudeProjectDirectory(
  cwd: string,
  claudeConfigDir?: string
): Promise<string | null> {
  const wsl = claudeUsesWsl()
  // The project-directory name is always derived from the working directory
  // as the CLI itself sees it, regardless of which CLAUDE_CONFIG_DIR
  // (account) is active. The native Windows CLI names `D:\baguette` as
  // `D--baguette` — verified against the main PC's real account dirs.
  const dirName = claudeProjectDirName(wsl ? toWslPath(cwd) : cwd)
  if (claudeConfigDir) {
    // Custom accounts already live at a plain Windows path (see
    // resolveLaunch), so no WSL probe is needed to reach them —
    // CLAUDE_CONFIG_DIR/projects/<dirName>. Verified against this machine's
    // real account dirs, which do use exactly this layout and naming.
    return join(claudeConfigDir, 'projects', dirName)
  }
  // Without this, a native-Windows Claude never got an id, so every restored
  // tab fell back to --continue and they all opened the same conversation.
  if (!wsl) return join(os.homedir(), '.claude', 'projects', dirName)
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

// ---- Listing ---------------------------------------------------------------------

const LABELS: Record<Provider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  copilot: 'Copilot',
  antigravity: 'Antigravity',
  shell: 'Shell'
}

const HINTS: Record<Provider, string> = {
  claude: '找不到 claude，請在 Windows 或 WSL 安裝 Claude Code。',
  codex: '找不到 codex，請在 Windows 或 WSL 安裝 OpenAI Codex CLI。',
  copilot: '找不到 copilot，請在 Windows 或 WSL 安裝 GitHub Copilot CLI。',
  antigravity: '找不到 agy，請在 Windows 或 WSL 安裝 Antigravity CLI。',
  shell: '找不到可用的 shell（pwsh / powershell / cmd / WSL）。'
}

/** Hint for a provider that is installed, just not where the preference allows. */
function prefHint(id: Provider, pref: RuntimePref): string {
  return pref === 'windows'
    ? `設定為只用 Windows 版，但 Windows 上找不到 ${LABELS[id]}。`
    : `設定為只用 WSL 版，但 WSL 裡找不到 ${LABELS[id]}。`
}

/** Metadata for every provider, including live availability detection. */
export function listProviders(): ProviderMeta[] {
  return PROVIDERS.map((id) => {
    const pref = prefOf(id)
    const win = windowsCommand(id)
    const resolved = resolveLaunch(id, os.homedir())
    const wslAvailable = wslKnown(id)
    const runtime: Runtime | undefined = resolved ? (resolved.command === wslExePath() ? 'wsl' : 'windows') : undefined
    const installedElsewhere = !resolved && (!!win || wslAvailable === true)
    log.info(
      `provider ${id} (${pref}): ${resolved ? `${resolved.command} ${resolved.args.join(' ')}`.trim() : 'not available'}`
    )
    return {
      id,
      label: LABELS[id],
      available: resolved !== null,
      command: resolved?.command,
      hint: resolved ? undefined : installedElsewhere ? prefHint(id, pref) : HINTS[id],
      runtime,
      windowsCommand: win,
      wslAvailable,
      pref
    }
  })
}
