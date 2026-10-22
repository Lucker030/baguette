param(
  [string]$LogPath,
  [string[]]$CmdArgs
)
# This machine's user profile contains CJK characters (EthanLin林郁宸). Node v22
# crashes (access violation) when the module/script path it loads contains those
# characters, so we run everything through 8.3 SHORT paths, which stay ASCII.
$ErrorActionPreference = 'Stop'
$fso = New-Object -ComObject Scripting.FileSystemObject

function To-Short([string]$p) {
  if ([string]::IsNullOrWhiteSpace($p)) { return $p }
  if (Test-Path -LiteralPath $p) {
    $item = Get-Item -LiteralPath $p
    if ($item.PSIsContainer) { return $fso.GetFolder($item.FullName).ShortPath }
    # For files, shorten only the parent dir (strips the CJK ancestor) and keep
    # the real leaf name. 8.3 short paths uppercase the extension (e.g. .JS),
    # which Node's ESM loader rejects — preserving the leaf avoids that.
    $shortParent = $fso.GetFolder($item.DirectoryName).ShortPath
    return (Join-Path $shortParent $item.Name)
  }
  return $p
}

# npm runs lifecycle scripts through a shell taken from %ComSpec%. This sandbox
# launches with ComSpec unset, which makes npm's spawnWithShell pass an undefined
# shell and crash with ERR_INVALID_ARG_TYPE. Restore a sane default.
if ([string]::IsNullOrWhiteSpace($env:ComSpec)) {
  $env:ComSpec = Join-Path $env:SystemRoot 'System32\cmd.exe'
}

# This sandbox launches with PATHEXT = ".CPL" only. cmd.exe uses PATHEXT to
# resolve bare commands, so `node`/`prebuild-install` (node.exe / *.cmd) are
# "not recognized" inside lifecycle scripts. Restore the standard list.
$env:PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC'

$rootLong = Split-Path $PSScriptRoot -Parent
$rootShort = To-Short $rootLong
$node = Join-Path $rootShort 'tools\node\node.exe'

# Lifecycle scripts (e.g. node-pty's postinstall) invoke a bare `node`/`npm`
# through cmd.exe. Our portable Node isn't on the system PATH, so prepend its
# short-path dir so those scripts resolve `node`.
$nodeDir = Join-Path $rootShort 'tools\node'
if (($env:Path -split ';') -notcontains $nodeDir) {
  $env:Path = "$nodeDir;$env:Path"
}

# Convert any argument that is an existing path to its short form.
$args2 = @()
foreach ($a in $CmdArgs) {
  if ($a -and (Test-Path -LiteralPath $a -ErrorAction SilentlyContinue)) { $args2 += (To-Short $a) }
  else { $args2 += $a }
}

$errPath = "$LogPath.err"
$p = Start-Process -FilePath $node -ArgumentList $args2 -NoNewWindow -Wait -PassThru `
  -WorkingDirectory $rootShort `
  -RedirectStandardOutput $LogPath -RedirectStandardError $errPath
if (Test-Path -LiteralPath $errPath) {
  $err = Get-Content -LiteralPath $errPath -Raw
  if ($err) { Add-Content -LiteralPath $LogPath -Value $err }
}
Write-Output "EXITCODE=$($p.ExitCode)"
Write-Output "NODE=$node"
Write-Output "CWD=$rootShort"
