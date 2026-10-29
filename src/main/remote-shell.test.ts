import { describe, expect, it } from 'vitest'
import { runPowerShell } from './remote-shell'

// Real powershell.exe runs: what matters is what arrives on the other PC —
// readable Chinese, the real exit code, and a runaway command actually killed.

describe.runIf(process.platform === 'win32')('runPowerShell', () => {
  it('returns UTF-8 output and the exit code, with no CLIXML noise', async () => {
    const r = await runPowerShell({ command: "Write-Output '中文 ok'; Write-Progress -Activity x; exit 3", timeoutMs: 30_000 })
    expect(r.stdout.trim()).toBe('中文 ok')
    expect(r.exitCode).toBe(3)
    expect(r.stderr).not.toMatch(/CLIXML/)
    expect(r.timedOut).toBe(false)
  }, 40_000)

  it('runs in the given directory', async () => {
    const r = await runPowerShell({ command: '(Get-Location).Path', cwd: 'C:\\Windows', timeoutMs: 30_000 })
    expect(r.stdout.trim()).toBe('C:\\Windows')
  }, 40_000)

  it('kills a command that runs past its timeout', async () => {
    const r = await runPowerShell({ command: 'Start-Sleep 60', timeoutMs: 1500 })
    expect(r.timedOut).toBe(true)
    expect(r.durationMs).toBeLessThan(20_000)
  }, 40_000)
})
