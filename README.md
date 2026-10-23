# baguette

<img src="build/icon-preview.png" alt="baguette icon" width="96" align="right">

A Windows desktop app that runs Claude Code, Codex, Copilot, Antigravity
(`agy`) and a plain shell as tabs in one window, plus panels for Skills,
hooks, to-dos and notes.

## Install

Download `baguette-Setup-<version>.exe` from [Releases](../../releases) and run
it. You can pick the install folder. New tabs start in the folder the app's
`.exe` is in until you set another 預設工作目錄 in 設定.

## Features

- **Tabs** — real terminals, grouped, split, renamed; reopened on next launch.
- **Windows or WSL, per CLI** — each CLI is found whether it's installed on
  Windows (official installer, npm, pnpm, bun, Volta, Scoop, winget) or inside
  WSL. 設定 → CLI 執行環境 shows both and lets you pick 自動 / Windows / WSL.
- **Attention dot** — a tab that finished working gets marked, with a Windows
  notification if the window is in the background.
- **Shortcuts** — Ctrl+Shift+T new tab, Ctrl+Shift+W close, Alt+1…9 jump,
  Ctrl+Shift+D split, Ctrl+Shift+F search. Full list in 設定.
- **Tray** — closing the window keeps sessions running in the tray.
- **Multiple accounts** — Claude, Codex and Copilot each keep several logins
  side by side; for Claude, log in once and every tab picks it up.
- **Skills 庫 / Hook 庫** — browse and manage Claude Code skills and hooks.
- **代辦事項 / 知識庫** — daily to-dos and notes that a Claude session can also
  write into.
- **Updates** — the app checks this repo's GitHub Releases, and 設定 → 更新
  downloads, verifies (sha512 from `latest.yml`) and installs a newer build.

## Development

```sh
npm install
npm run dev        # run in dev mode
npm test           # tests
npm run dist       # build the installer into release/
```

The repo must sit on an English-only path; Node crashes on paths with Chinese
characters. If yours does, see [`tools/README.md`](tools/README.md).

## Release

Bump `version` in `package.json`, commit, then push a tag `v<version>`
(`git tag v1.0.1 && git push origin v1.0.1`). Actions refuses a tag that
disagrees with `package.json`, builds `baguette-Setup-<version>.exe` and
publishes it with `latest.yml`; installed copies pick it up on their next
check.

Stack: Electron · React · xterm.js · TypeScript · Tailwind · Vitest.
