# baguette

<img src="build/icon-preview.png" alt="baguette icon" width="96" align="right">

把多個 AI CLI 放在同一個視窗裡用分頁開的 Windows 桌面 App。

## 支援的 AI

| | Windows 版 | WSL 版 |
|---|---|---|
| Claude Code | ✅ | ✅ |
| Codex | ✅ | ✅ |
| GitHub Copilot | ✅ | ✅ |
| Antigravity（`agy`） | ✅ | ✅ |
| 一般終端 | PowerShell | WSL bash |

- 裝在 Windows 或 WSL 都會自動偵測；官方安裝程式、npm、pnpm、bun、Volta、Scoop、winget 裝的都找得到。
- 兩邊都有裝時，可在「設定 → CLI 執行環境」選要用哪一版。

## 功能

- **分頁** — 真正的終端，可分組、分割畫面、改名；重開 App 會接回上次的對話。
- **多帳號** — Claude、Codex、Copilot 都能存多個帳號，一鍵切換。
- **提醒** — 背景分頁跑完或在等你確認時，側欄亮黃點並跳 Windows 通知。
- **系統匣** — 關掉視窗 session 繼續跑。
- **Skills 庫 / Hook 庫** — 管理 Claude Code 的 skills 和 hooks。
- **代辦事項 / 知識庫** — Claude 也能直接寫進來。
- **自動更新** — 從這個 repo 的 Releases 檢查新版，一鍵下載安裝。

## 安裝

到 [Releases](../../releases) 下載 `baguette-Setup-<版本>.exe` 執行即可。

## 開發

```sh
npm install
npm run dev     # 開發模式
npm test        # 測試
npm run dist    # 打包安裝檔到 release/
```

發新版：改 `package.json` 的 `version`，commit 後推 `v<版本>` tag，GitHub Actions 會自動建置並發布。
