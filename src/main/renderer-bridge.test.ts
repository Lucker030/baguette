import { describe, expect, it, vi } from 'vitest'
import { sendToRenderer, type RendererTarget } from './renderer-bridge'

// Regression cover for the "A JavaScript error occurred in the main process /
// TypeError: Object has been destroyed" crash: pty output kept arriving after
// the window closed, and the old `mainWindow?.webContents.send(...)` guard only
// caught null, not a destroyed-but-still-referenced BrowserWindow.

function fakeWindow(
  over: { destroyed?: boolean; webContentsDestroyed?: boolean; throwOnSend?: boolean } = {}
): { win: RendererTarget; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(() => {
    if (over.throwOnSend) throw new TypeError('Object has been destroyed')
  })
  return {
    win: {
      isDestroyed: () => over.destroyed ?? false,
      webContents: {
        isDestroyed: () => over.webContentsDestroyed ?? false,
        send
      }
    },
    send
  }
}

describe('sendToRenderer', () => {
  it('delivers to a live window', () => {
    const { win, send } = fakeWindow()
    sendToRenderer(win, 'session:data', { id: 's1', data: 'hi' })
    expect(send).toHaveBeenCalledWith('session:data', { id: 's1', data: 'hi' })
  })

  it('is a no-op when there is no window', () => {
    expect(() => sendToRenderer(null, 'session:data', {})).not.toThrow()
    expect(() => sendToRenderer(undefined, 'session:data', {})).not.toThrow()
  })

  it('does not touch a destroyed window', () => {
    const { win, send } = fakeWindow({ destroyed: true })
    sendToRenderer(win, 'session:data', {})
    expect(send).not.toHaveBeenCalled()
  })

  it('does not touch destroyed webContents', () => {
    const { win, send } = fakeWindow({ webContentsDestroyed: true })
    sendToRenderer(win, 'session:data', {})
    expect(send).not.toHaveBeenCalled()
  })

  it('swallows a teardown race between the check and the send', () => {
    // The window passes both isDestroyed() checks but dies before send lands.
    const { win } = fakeWindow({ throwOnSend: true })
    expect(() => sendToRenderer(win, 'session:data', {})).not.toThrow()
  })
})
