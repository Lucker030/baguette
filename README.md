# baguette

<img src="build/icon-preview.png" alt="baguette icon" width="96" align="right">

A Windows desktop app that runs Claude Code, Codex, Copilot and a plain shell
as tabs in one window, plus panels for Skills, hooks, to-dos and notes.

## Install

Download `Local Platform Setup <version>.exe` from
[Releases](../../releases) and run it. You can pick the install folder.

## Features

- **Tabs** — real terminals, grouped, split, renamed; reopened on next launch.
- **Attention dot** — a tab that finished working gets marked, with a Windows
  notification if the window is in the background.
- **Shortcuts** — Ctrl+Shift+T new tab, Ctrl+Shift+W close, Alt+1…9 jump,
  Ctrl+Shift+D split, Ctrl+Shift+F search. Full list in 設定.
- **Tray** — closing the window keeps sessions running in the tray.
- **Multiple Claude accounts** — work and personal logins side by side; log in
  once and every tab picks it up.
- **Skills 庫 / Hook 庫** — browse and manage Claude Code skills and hooks.
- **代辦事項 / 知識庫** — daily to-dos and notes that a Claude session can also
  write into.
- **Updates** — point 設定 → 更新 at a folder; drop a new `.exe` + `latest.yml`
  there and the app updates itself.

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

Bump `version` in `package.json`, then create a release with tag `v<version>`
on GitHub. Actions builds the installer and attaches it.

Stack: Electron · React · xterm.js · TypeScript · Tailwind · Vitest.
