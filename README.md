# baguette

<img src="build/icon-preview.png" alt="baguette icon" width="96" align="right">

An Electron desktop app that multiplexes CLI AI agent sessions — Claude Code,
Codex, Copilot, Antigravity (`agy`) and a plain shell — into one tabbed terminal UI,
with libraries for Skills, hooks, daily to-dos and a knowledge base.

## Features

- **Tabbed CLI sessions** backed by real ptys (`node-pty`), grouped in a
  sidebar. Tabs can be renamed, dragged between groups, split side by side,
  and reopened on the next launch (each resumes its own CLI conversation).
- **Attention tracking** — the sidebar shows which tabs are producing output
  right now, and marks a tab you are *not* looking at with an amber dot once
  it goes quiet after working (a finished Claude turn, a permission prompt, a
  build that ended) or rings the bell. If the window is not in front, that
  also raises a Windows notification and flashes the taskbar; clicking the
  notification jumps to the tab. The heuristic lives in `src/main/activity.ts`
  and is what its tests describe.
- **Terminal niceties** — Ctrl+Shift+F search with match count, clickable
  URLs, Ctrl+= / Ctrl+- font zoom shared by every terminal, Ctrl+Shift+C copy,
  Ctrl+V / right-click paste (an image on the clipboard pastes as a temp PNG
  path), drag-and-drop of files to type their path.
- **Keyboard-driven tabs** — Ctrl+Shift+T new session, Ctrl+Shift+W close,
  Ctrl+Tab / Ctrl+Shift+Tab cycle, Alt+1…9 jump, Ctrl+Shift+D split. The full
  table is in 設定 and in `src/renderer/src/shortcuts.ts`.
- **System tray** — closing the window hides it to the tray by default and
  every session keeps running; quit from the tray menu. Can be turned off in
  設定, after which ✕ ends all sessions as before.
- **Updates from GitHub Releases** — after launch and every six hours the app
  asks the GitHub API for the latest Release of
  [Lucker030/baguette](https://github.com/Lucker030/baguette/releases). If it
  carries a newer `baguette-Setup-<ver>.exe` the app shows a toast, and 設定 →
  更新 「下載安裝並重新啟動」 downloads it, verifies its sha512 against the
  Release's `latest.yml`, runs it silently with the same flags
  electron-updater uses (`/S --updated --force-run`), and the installer
  relaunches the app. Pushing a `v*` tag runs `.github/workflows/release.yml`,
  which builds and publishes exactly those two files. See
  `src/main/updater.ts`.
- **Crash resilience and a log** — each screen sits in its own React error
  boundary so one broken panel cannot blank the terminals; main-process
  exceptions are caught, logged to `userData/logs/main.log` (opened from 設定)
  and surfaced as a toast instead of killing every session; a renderer crash
  reloads the UI and re-adopts the sessions that are still alive in the main
  process rather than re-spawning them.
- **Multiple Claude accounts** — each is an isolated `CLAUDE_CONFIG_DIR`, so
  work and personal logins coexist. A group can be *bound* to an account, so
  sessions started in it always run under that identity.
- **One login for every tab** — each `claude` process refreshes its OAuth
  token on its own, and a refresh rotates the refresh token, so with several
  tabs open the first one to refresh strands the others on "run /login". The
  app watches each Claude tab for that message (the tab gets a banner and a
  「需要登入」 badge), watches the account's `.credentials.json` for the write a
  successful `/login` makes, and then restarts every stuck tab of that
  account in place on its own conversation id. Sign in once, in any tab; the
  rest follow. Each banner also has 「現在重啟」 for doing it by hand. See
  `src/main/auth-watch.ts`.
- **Skills 庫** — browse `~/.claude/skills` and the project's `.claude/skills`,
  and scaffold new ones.
- **Hook 庫** — manage Claude Code hooks, mirrored into
  `~/.claude/settings.json`. The pseudo-event `Schedule` has no Claude Code
  equivalent and is instead backed by a Windows Scheduled Task, so it fires at
  wall-clock time whether or not this app is running.
- **代辦事項** — a daily to-do list. It is backed by one plain JSON file in
  userData that a Claude Code session also writes to (the `daily-todos` skill),
  and the panel follows that file, so to-dos assigned in a terminal tab appear
  without a refresh.
- **知識庫** — a free-form notes/wiki store (title, content, tags), same
  file-and-skill convention as 代辦事項: a Claude Code session can capture a
  lesson learned directly into it (the `knowledge-capture` skill) and the
  panel follows the file live.

Earlier versions also shipped a 遊戲區 (five card/dice games with REST-backed
AI seats) and a 學習區 (LeetCode/SQL/Japanese drills, a TOEIC vocabulary book,
an NYT RSS reader). Both were removed in 0.25.0 along with the AI-vendor REST
layer and API-key storage that only they used. That code is not part of this
repository's history.

## Stack

Electron 43 · React 18 · Zustand · xterm.js · Tailwind · TypeScript · Vite 7
(via electron-vite) · Vitest.

Source layout:

| Path | Role |
|---|---|
| `src/main/` | Main process: IPC handlers, pty spawning, provider resolution, on-disk state |
| `src/preload/` | The `contextBridge` API surface exposed to the renderer |
| `src/renderer/` | React UI (`components/`, `store/`, `hooks/`) |
| `src/shared/` | Types shared across processes |
| `tools/` | Windows CJK short-path workaround — **see `tools/README.md`** |

## Development

```sh
npm install
npm run dev        # electron-vite dev server
npm run build      # production build into out/
npm run lint       # eslint (incl. the react-hooks rules)
npm run typecheck  # tsc over both the node and web projects
npm test           # vitest
npm run dist       # build + package a Windows installer into release/
```

## Installing

`npm run dist` produces `release/baguette-Setup-<version>.exe`, an NSIS
installer, plus `latest.yml` beside it. It installs per-user (no admin prompt,
lands in `%LOCALAPPDATA%`) and creates Start Menu and desktop shortcuts, so
the app launches like any other Windows program — there is no batch file to
double-click any more. New sessions start in the folder the app's `.exe` is
in until a different 預設工作目錄 is set in 設定.

To ship an update: bump `version` in `package.json`, commit, then
`git tag v<version> && git push origin v<version>`. The Release workflow
refuses a tag that disagrees with `package.json`, builds the installer, and
publishes it with `latest.yml`; installed copies pick it up on their next
check.

Two packaging details worth knowing before changing `electron-builder.yml`:

- `npmRebuild: false` is deliberate and load-bearing. The only native
  dependency is node-pty, shipped prebuilt; letting electron-builder rebuild it
  invokes node-gyp, which needs a Visual Studio toolchain. Worse, node-gyp
  *empties* `node_modules/…/node-pty-prebuilt-multiarch/build/` before it fails,
  which breaks the app in dev too. Recover with
  `rm -r node_modules/@homebridge && npm install`.
- `asarUnpack` must keep covering node-pty. Its `.node` binaries,
  `winpty-agent.exe` and the ConPTY `OpenConsole.exe` helpers have to be real
  files on disk; they cannot be loaded from inside the asar archive.

### ⚠️ This machine cannot use a plain `node` / `npm`

The developer's Windows profile path contains CJK characters
(`C:\Users\<中文名>\…`), and Node's loader crashes (`0xC0000005`) when
resolving modules through a non-ASCII path. Everything therefore runs through
the Windows 8.3 **short** path using the portable Node vendored in
`tools/node`. Read [`tools/README.md`](tools/README.md) before touching the
toolchain — it documents the launch scripts, why they exist, how they can
silently break, and the Node version floor the Electron installer needs.

On a machine with an ASCII-only profile path none of that applies and the plain
npm scripts above work directly.

## Tests

`npm test` runs Vitest over `src/**/*.test.ts(x)`. Coverage focuses on the
logic where a silent bug would be most damaging:

- `src/main/hooks.test.ts` — the sync into the user's real
  `~/.claude/settings.json`. It must never drop hooks or keys it doesn't own,
  and must refuse to write at all when it cannot parse what's already there.
  Also the validation of hook definitions arriving over IPC.
- `src/main/activity.test.ts` — the "this tab needs you" heuristic, with a
  fake clock: a long output stretch that goes quiet counts, a prompt redraw
  doesn't, and the echo of the user's own typing must never count.
- `src/main/providers.test.ts` — the pure parts of launch resolution: PATHEXT
  preference in `which`, Windows→WSL path mapping, and Claude Code's
  project-directory naming rule (worked out empirically; easy to "tidy" wrong).
- `src/main/log.test.ts` — the log file creates its directory, keeps one entry
  per line, and rotates at 1 MB.
- `src/main/auth-watch.test.ts` — the "this tab needs a login" classifier,
  against the phrases Claude Code 2.1.x actually prints.
- `src/main/updater.test.ts` — which GitHub Release asset gets offered, when
  the sha512 from `latest.yml` is trusted, and that network/HTTP failures
  become a message rather than a throw.
- `src/main/skills.test.ts` — the hand-rolled SKILL.md frontmatter parser.
- `src/main/session-store.test.ts` — tolerating a corrupt/stale `sessions.json`.
- `src/main/renderer-bridge.test.ts` — not touching a destroyed window.
- `src/main/todos.test.ts` and `src/main/knowledge.test.ts` — the same
  tolerant-normalize-on-read contract, since a Claude Code session hand-edits
  both files directly (see the `daily-todos` and `knowledge-capture` skills).
- `src/renderer/src/store/sessions.test.ts` — which Claude account a new tab
  ends up running under.
- `src/renderer/src/hooks/useLoadable.test.ts` and
  `src/renderer/src/components/sidebar/SessionRow.test.tsx` — the extracted
  renderer primitives.

Every test file's `it()` names are worth skimming before touching that
module — they document behavior a change must not silently break.

Every test runs in the **node** environment. Renderer tests get their DOM by
importing `src/renderer/src/test-utils/jsdom-env.ts` rather than using Vitest's
`jsdom` environment, which cannot resolve modules under the short-path root on
this machine — that file explains the details.
