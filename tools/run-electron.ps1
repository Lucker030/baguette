param(
  [string]$LogPath = "$PSScriptRoot\electron.log",
  [switch]$Wait
)
# Launch the built Electron app using 8.3 SHORT (ASCII) paths to dodge the CJK
# module-load crash (see tools/run-node.ps1 for the full rationale).
$ErrorActionPreference = 'Stop'
$fso = New-Object -ComObject Scripting.FileSystemObject

function To-ShortDir([string]$p) {
  if (Test-Path -LiteralPath $p) { return $fso.GetFolder((Get-Item -LiteralPath $p).FullName).ShortPath }
  return $p
}

if ([string]::IsNullOrWhiteSpace($env:ComSpec)) { $env:ComSpec = Join-Path $env:SystemRoot 'System32\cmd.exe' }
$env:PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC'
# This sandbox sets ELECTRON_RUN_AS_NODE=1, which makes electron.exe behave as
# plain Node (require('electron') returns the exe path, so app/BrowserWindow are
# undefined). Clear it so Electron launches as a real GUI app.
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$rootLong  = Split-Path $PSScriptRoot -Parent
$rootShort = To-ShortDir $rootLong
$electron  = Join-Path $rootShort 'node_modules\electron\dist\electron.exe'

$env:ELECTRON_ENABLE_LOGGING = '1'
$errPath = "$LogPath.err"
$p = Start-Process -FilePath $electron -ArgumentList @($rootShort) -PassThru -NoNewWindow `
  -WorkingDirectory $rootShort -RedirectStandardOutput $LogPath -RedirectStandardError $errPath
Write-Output "PID=$($p.Id)"
Write-Output "ELECTRON=$electron"
if ($Wait) { $p.WaitForExit(); Write-Output "EXITCODE=$($p.ExitCode)" }
