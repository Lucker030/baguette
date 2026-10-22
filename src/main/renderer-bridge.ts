/**
 * The slice of BrowserWindow we actually need, kept structural so tests can
 * fake it without an Electron runtime.
 */
export interface RendererTarget {
  isDestroyed(): boolean
  webContents: {
    isDestroyed(): boolean
    send(channel: string, payload: unknown): void
  }
}

/**
 * Push an event to the renderer, tolerating a window that is already gone.
 *
 * `win?.webContents.send(...)` is NOT enough: optional chaining only guards
 * null/undefined, while a closed BrowserWindow is a live object whose native
 * side has been torn down. Touching it throws `TypeError: Object has been
 * destroyed`, and because these calls run from a pty 'data' listener — not
 * from an IPC handler — nothing catches it, so it surfaces as an "A JavaScript
 * error occurred in the main process" dialog.
 *
 * This is reachable in normal use: closing the app makes each CLI flush a
 * final chunk of output as it dies, which arrives after the window is gone.
 */
export function sendToRenderer(
  win: RendererTarget | null | undefined,
  channel: string,
  payload: unknown
): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  try {
    win.webContents.send(channel, payload)
  } catch {
    /* destroyed between the check and the send — nothing left to deliver to */
  }
}
