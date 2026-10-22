# tools/

This folder exists to work around one specific problem: **this machine's Windows
user profile path contains CJK characters** (`C:\Users\EthanLin林郁宸\...`), and
Node's native module loader crashes (`0xC0000005`) when it has to resolve
modules through a non-ASCII path. Everything here forces the app to run through
the Windows 8.3 **short (ASCII) path** instead.

## What's in here

- `node/` — a portable Node.js runtime, vendored so `npm`/`electron-vite` can
  run from the short path without depending on a system Node install that may
  itself be invoked from the long CJK path. (gitignored — not committed)
- `npm-cache/`, `electron-cache/` — caches pointed at the short path for the
  same reason. (gitignored)
- `launch.ps1` — launches the app straight from this working copy: resolves the
  project's 8.3 short path via `Scripting.FileSystemObject`, builds if `out/`
  is missing, then starts Electron through it. This is a *developer*
  convenience. End users no longer need it — `npm run dist` produces a proper
  NSIS installer with Start Menu/desktop shortcuts, which replaced the old
  `Local Platform.bat`.
- `run-node.ps1`, `run-electron.ps1` — same short-path trick for running
  `node`/`electron` ad hoc from a terminal during development.

## Why this is fragile — read before deleting or "cleaning up"

- It depends on **Windows 8.3 short filename generation being enabled** on the
  volume (`fsutil 8dot3name query C:`). Some systems disable this (it has a
  small perf cost on directories with many files), which would silently make
  every script here fail to find a valid short path and reintroduce the
  original crash.
- It only works on **Windows** — `Scripting.FileSystemObject` and `schtasks`
  (used elsewhere by the Hook 庫) have no equivalent here.
- On any machine whose user profile path is plain ASCII, **none of this is
  needed** — the app would run fine invoking `node`/`electron` directly. If
  this project is ever moved to run from an ASCII-only path (a different
  machine, a CI runner, WSL), consider whether `tools/` should be bypassed
  entirely rather than carried along as dead weight.

If you're taking over this project on a machine without a CJK-path issue, you
likely don't need `tools/` at all — `npm run dev` / `npm run build` directly
should work.

## Keeping `tools/node` current

`electron`'s own postinstall (`install.js`) requires Node's `require(esm)`
support, which needs **Node >= 22.12.0**. If you bump the `electron` dependency
in `package.json` and its native `.exe` fails to download with
`ERR_REQUIRE_ESM` from `install.js`, that's why — replace `tools/node` with a
newer official Windows Node zip from https://nodejs.org/dist/ (matching
architecture, e.g. `node-vX.Y.Z-win-x64.zip`) extracted over the existing
layout (`node.exe`, `npm`/`npm.cmd`, `node_modules/npm/...`, etc.), then rerun
`npm install` (or `node node_modules/electron/install.js` directly if npm
skips it because it thinks nothing changed).
