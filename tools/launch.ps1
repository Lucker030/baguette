$ErrorActionPreference = 'Stop'
# One-click launcher for baguette. Handles this machine's quirks:
#  - CJK user-profile path -> run everything through 8.3 SHORT (ASCII) paths.
#  - Some shells launch with ComSpec/PATHEXT unset or ELECTRON_RUN_AS_NODE=1;
#    normalize them (harmless on a normal machine).
$fso = New-Object -ComObject Scripting.FileSystemObject
$root = Split-Path $PSScriptRoot -Parent
$rootShort = $fso.GetFolder($root).ShortPath
$node     = Join-Path $rootShort 'tools\node\node.exe'
$electron = Join-Path $rootShort 'node_modules\electron\dist\electron.exe'

if ([string]::IsNullOrWhiteSpace($env:ComSpec)) { $env:ComSpec = Join-Path $env:SystemRoot 'System32\cmd.exe' }
$env:PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC'
if (Test-Path Env:ELECTRON_RUN_AS_NODE) { Remove-Item Env:ELECTRON_RUN_AS_NODE }
$env:ELECTRON_CACHE = Join-Path $rootShort 'tools\electron-cache'
$nodeDir = Join-Path $rootShort 'tools\node'
if (($env:Path -split ';') -notcontains $nodeDir) { $env:Path = "$nodeDir;$env:Path" }

# Always rebuild. This script is now a developer entry point (end users get the
# NSIS installer), and "only build when out/ is missing" silently launched a
# stale build after the first run.
$ev = Join-Path $rootShort 'node_modules\electron-vite\bin\electron-vite.js'
Start-Process -FilePath $node -ArgumentList @($ev, 'build') -NoNewWindow -Wait -WorkingDirectory $rootShort

# Launch the Electron GUI, detached, so this script can exit immediately.
Start-Process -FilePath $electron -ArgumentList @($rootShort) -WorkingDirectory $rootShort
