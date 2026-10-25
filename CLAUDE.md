# baguette — notes for Claude Code sessions

Electron desktop app that runs several AI CLI sessions (Claude Code, Codex,
Copilot, plain shell) as tabs over real ptys, plus small side panels: Skills
庫, Hook 庫, 知識庫, 內網裝置. Read `README.md` for the feature list and
`tools/README.md` before touching anything about how the toolchain is launched.

## Running checks on THIS machine

The user profile path contains CJK characters and Node crashes loading modules
through it, so nothing here runs with a plain `node`/`npm`. There is no system
Node or Python on PATH inside the Bash tool either. Use the portable Node from
the project's 8.3 short path, in PowerShell:

```powershell
$short = 'C:\Users\ETHANL~1\Desktop\LOCAL_~1'
$node  = "$short\tools\node\node.exe"
if (-not $env:ComSpec) { $env:ComSpec = "$env:SystemRoot\System32\cmd.exe" }
$env:PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Set-Location $short
& $node "$short\node_modules\typescript\bin\tsc" --noEmit -p tsconfig.node.json
& $node "$short\node_modules\typescript\bin\tsc" --noEmit -p tsconfig.web.json
& $node "$short\node_modules\eslint\bin\eslint.js" src
& $node "$short\node_modules\vitest\vitest.mjs" run
& $node "$short\node_modules\electron-vite\bin\electron-vite.js" build
```

npm itself: `& $node "$short\tools\node\node_modules\npm\bin\npm-cli.js" <args>`
with `--ignore-scripts` when adding/removing packages, so node-pty's install
script is never re-run (see the `npmRebuild` comment in electron-builder.yml).

Packaging the installer (`release/baguette-Setup-<version>.exe`):

```powershell
$env:PATH = "$short\tools\node;$env:PATH"   # electron-builder shells out to `npm list`
$env:ELECTRON_BUILDER_CACHE = "$short\tools\builder-cache"
$env:ELECTRON_CACHE = "$short\tools\electron-cache"
& $node "$short\node_modules\electron-vite\bin\electron-vite.js" build
& $node "$short\node_modules\electron-builder\cli.js" --win
```

Without `tools\node` on PATH it fails with "No JSON content found in output":
that is the npm dependency walk finding no `npm`, not a config problem.

Two more packaging failure shapes, both environmental:
- `EBUSY ... release\win-unpacked\baguette.exe` while the user has the
  unpacked build running: don't kill their app — build into another folder
  with `--config.directories.output=release/tmp-<ver>` and move the installer.
- A transient `EBUSY` on a freshly written exe (AV scanning it): just retry.

Multi-file mechanical edits are easiest as a small `.js` script run with that
`node.exe`; the Bash tool has no scripting runtime.

Before saying a change is done: typecheck (both projects), eslint, vitest, and
`electron-vite build` all pass. CI (`.github/workflows/ci.yml`) runs the same
on an ASCII path on every push to GitHub; a red CI run is a real failure, not
noise.

## Conventions that matter

- **IPC input is untrusted.** Every `ipcMain.handle` rebuilds its input from
  checked fields (`sanitizeProvider`, `sanitizeLaunch`, `sanitizeHookPatch`,
  `updateSettings`). Never spread a renderer object into state or onto disk.
- **Atomic writes.** Anything persisted goes through `writeFileAtomic`
  (`src/main/atomic-write.ts`). `~/.claude/settings.json` is the user's file:
  `hooks.ts` must refuse to write when it cannot parse what is there.
- **Files a Claude session also edits** (`knowledge.json`) are
  normalized on read so a hand-written entry can never break a panel.
- **Main-process events from ptys** go through `sendToRenderer`, never a bare
  `webContents.send` — the window may already be destroyed.
- **Errors get logged**, not swallowed silently: `log.error(...)` in main
  (`src/main/log.ts`, file at `userData/logs/main.log`), `window.api.log` in
  the renderer. Each screen is wrapped in an `ErrorBoundary`.
- **Comments explain why**, especially anything verified empirically against
  WSL or Claude Code behaviour. Keep that style; don't strip them.
- Commit messages are `<area>: <what>` with a short body on the why, e.g.
  `終端: only push a resize when the size actually changed`. Bump
  `package.json` version in its own commit when cutting a build.

## Things deliberately not here

- 遊戲區 and 學習區 (games, LeetCode/SQL/Japanese drills, TOEIC vocab, NYT
  RSS) and the AI-vendor REST layer + API-key storage were removed in 0.25.0
  at the user's request. Do not re-add them. Same for 代辦事項 (daily todos,
  `todos.json`), removed in 1.0.2 when 內網裝置 took its place.
- LAN control (`lan.ts`, `lan-crypto.ts`, `lan-store.ts`, 內網裝置 screen):
  paired PCs drive each other's agent-bridge tabs through `AgentBridge.exec`
  with a `Caller` naming the device (own tabs only; writable only with that
  PC's allowWrite). Pairing is CPace over ristretto255 (`@noble/curves`), not
  a MAC of the code — a 6-digit code MAC'd in the clear is brute-forced
  offline in under a second. Sessions: pairing secret + fresh X25519, then
  AES-256-GCM frames with counter nonces. TCP 47610 (falls back to a random
  port, announced over discovery), UDP broadcast 47611. Off by default
  (`lanEnabled`). Secrets in `userData/lan.json` via safeStorage (DPAPI).
- LAN sync of 知識庫 / Skills / Hook 庫 (`lan-sync.ts`, `lan-sync-adapters.ts`),
  designed with a Codex review: nothing syncs on its own — the user presses
  開始同步 on either PC and that PC plans; a category syncs only if BOTH PCs
  ticked it (checked by the receiver on every call); the planner merges
  three-way against the base both PCs store (`userData/lan-sync.json`, sent
  over after each run); `skills/synced` (Claude Code's own) is skipped; both-
  changed keeps both versions (copy key), never a timestamp winner; deletes
  only propagate over an untouched copy, and never on a first sync; hooks
  arrive disabled; skills are validated and swapped as whole folders with
  backups in `~/.claude/.baguette-sync`. One peer per category.
- Agent-bridge tabs go in the sidebar group 「AI 討論區」 (`AI_GROUP_NAME` in
  the store), not a 🤖 name prefix — the user asked for that.
- The MCP server (`src/main/mcp.ts` → `out/main/mcp.js`, asarUnpack'd) is a
  standalone script an AI CLI runs as `ELECTRON_RUN_AS_NODE=1 baguette.exe
  mcp.js <agent-bridge.json>`; it only calls the local bridge, which relays
  `/v1/devices/<id>/...` over the LAN. Keep it free of imports from the app.
  Verified end to end on the idle PC with two instances (`--user-data-dir`).
- Updates come from GitHub Releases of `Lucker030/baguette`
  (`src/main/updater.ts`, `GITHUB_REPO`), via the unauthenticated REST API —
  no electron-updater, no token. `.github/workflows/release.yml` publishes
  `baguette-Setup-<ver>.exe` + `latest.yml` on a `v*` tag; the `artifactName`
  in electron-builder.yml and `INSTALLER_RE` in updater.ts must agree. The
  old folder-based updater (`settings.updateDir`) is gone.
- Everything is named **baguette** since 1.0.0 (`productName`, package.json
  `name`, appId `com.ethanlin.baguette`). The previous names were `Local
  Platform` / `local-platform` / `DashBoard`. The rename was done without a
  userData migration at the user's request, so an install under the old name
  keeps its own data and is a separate app as far as Windows is concerned.
  Electron names the userData folder after productName (packaged) or `name`
  (`electron-vite dev`), so changing either again moves all user data.
- The default working directory for new sessions is the folder the app's
  exe sits in (`exeDir()` in settings.ts), not the user profile on C:.
- `build/icon.ico` is generated by `scripts/make_icon.py` (same drawing style
  as the sausage project's icon); regenerate rather than hand-edit.
- No `python` provider any more; `Provider` is
  `claude | codex | copilot | antigravity | shell`. Antigravity's CLI is
  `agy` (`%LOCALAPPDATA%\agy\bin\agy.exe`); the Codex provider is labelled
  "Codex", not "ChatGPT".
- Accounts are per CLI (`Account.provider`, `ACCOUNT_DIR_ENV` in
  shared/types.ts): CLAUDE_CONFIG_DIR / CODEX_HOME / COPILOT_HOME. Claude's
  current account stays in `currentAccountId` (groups bind Claude accounts);
  the others are in `currentAccounts`. CODEX_HOME verified (an empty one
  reports "Not logged in"); COPILOT_HOME verified to move copilot's config
  dir (sign-in separation untested). `which()` also reads the live user +
  machine PATH from the registry, so a CLI installed while the app runs is
  found without a restart.
- Every provider runs either as a Windows install or inside WSL
  (`resolveLaunch` in providers.ts); `settings.runtimePrefs` picks auto /
  windows / wsl per provider (設定 → CLI 執行環境). WSL is probed with ONE
  call for all CLIs (`command -v claude codex copilot agy; echo <marker>`) —
  only a reply containing the marker counts as an answer. A WSL shell tab is
  `wsl.exe --cd <dir>`. WSL only sees local drives under /mnt; a cwd on a
  network drive (G:, X: ... here) cannot be entered from WSL. `agy` has no account switching on purpose: verified that it
  keys its config off USERPROFILE (`~/.gemini`) but keeps its sign-in in one
  fixed Windows Credential Manager entry, `gemini:antigravity`; with an empty
  USERPROFILE it is still signed in. A per-account folder therefore cannot
  switch its account.
