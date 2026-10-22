import { app, Menu, nativeImage, Tray } from 'electron'
import { join } from 'node:path'

// The system tray icon. It exists so that closing the window can mean "get
// out of my way" rather than "kill every CLI session I have open" — with
// closeToTray on, the window hides here and the sessions keep running, and
// this is also the only place left to actually quit from.

/**
 * The installer copies build/icon.ico next to the app as an extraResource
 * (see electron-builder.yml); in dev it is read straight from the repo.
 */
export function appIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.ico')
    : join(app.getAppPath(), 'build', 'icon.ico')
}

export function createTray(handlers: { onShow: () => void; onQuit: () => void }): Tray | null {
  let tray: Tray
  try {
    tray = new Tray(nativeImage.createFromPath(appIconPath()))
  } catch {
    // No icon file, or a platform without a tray. The app still works; only
    // close-to-tray would strand a hidden window, and index.ts checks for that.
    return null
  }
  tray.setToolTip('DashBoard')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '顯示 DashBoard', click: handlers.onShow },
      { type: 'separator' },
      { label: '結束（會關閉所有 session）', click: handlers.onQuit }
    ])
  )
  tray.on('click', handlers.onShow)
  tray.on('double-click', handlers.onShow)
  return tray
}
