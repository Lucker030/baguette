import { spawn } from 'node:child_process'

// Remote PowerShell: a paired PC runs a command on this one directly over the
// LAN session, without going through an AI tab. It is the strongest thing a
// peer can do here, so lan.ts only serves it to a peer this PC turned
// allowShell on for (off by default, separate from allowWrite), and every
// command is logged with who sent it.
//
// No Electron imports, so tests can run it as-is.

export interface ShellRequest {
  command: string
  cwd?: string
  timeoutMs: number
}

export interface ShellResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
  durationMs: number
}

export const MAX_COMMAND = 100_000
/** Per stream; the rest is dropped and `truncated` set. */
const MAX_OUTPUT = 1_000_000
export const SHELL_TIMEOUT_DEFAULT_MS = 300_000
export const SHELL_TIMEOUT_MAX_MS = 3_600_000

/**
 * Windows PowerShell writes redirected output in the OEM code page (cp950
 * here), which turns Chinese into mojibake on the other side, and reports
 * progress bars as CLIXML on stderr. Both are switched off before the
 * caller's command runs.
 */
export function wrapCommand(command: string): string {
  return [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    '$OutputEncoding = [Text.Encoding]::UTF8',
    "$ProgressPreference = 'SilentlyContinue'",
    command
  ].join('\n')
}

/** -EncodedCommand takes UTF-16LE base64, which avoids every quoting problem. */
export function encodeCommand(command: string): string {
  return Buffer.from(wrapCommand(command), 'utf16le').toString('base64')
}

export function runPowerShell(req: ShellRequest): Promise<ShellResult> {
  const t0 = Date.now()
  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-EncodedCommand', encodeCommand(req.command)],
      { cwd: req.cwd || undefined, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const out = { stdout: [] as Buffer[], stderr: [] as Buffer[], size: { stdout: 0, stderr: 0 } }
    let truncated = false
    let timedOut = false
    const collect = (stream: 'stdout' | 'stderr') => (c: Buffer) => {
      const room = MAX_OUTPUT - out.size[stream]
      if (room <= 0) {
        truncated = true
        return
      }
      if (c.length > room) truncated = true
      const part = c.subarray(0, room)
      out[stream].push(part)
      out.size[stream] += part.length
    }
    child.stdout.on('data', collect('stdout'))
    child.stderr.on('data', collect('stderr'))
    const timer = setTimeout(() => {
      timedOut = true
      // The whole tree: a command may have started its own children.
      if (child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    }, req.timeoutMs)
    const finish = (exitCode: number | null, extra = ''): void => {
      clearTimeout(timer)
      resolve({
        exitCode,
        stdout: Buffer.concat(out.stdout).toString('utf8'),
        stderr: Buffer.concat(out.stderr).toString('utf8') + extra,
        timedOut,
        truncated,
        durationMs: Date.now() - t0
      })
    }
    child.on('error', (e) => finish(null, e.message))
    child.on('close', (code) => finish(code))
  })
}
