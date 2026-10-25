import '../test-utils/jsdom-env'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AppSettings, LanState } from '@shared/types'
import { useApp } from '../store/sessions'
import { DevicesPanel } from './DevicesPanel'

// The screen a user pairs from: the parts pinned here are the ones a refactor
// could quietly break — which device a typed code goes to, that main's error
// text reaches the user readable, and the MCP command the user copies.

afterEach(cleanup)

const lanState = (over: Partial<LanState['status']> = {}): LanState => ({
  status: {
    running: true,
    deviceId: 'me',
    deviceName: 'MAIN-PC',
    port: 47610,
    addresses: ['192.168.0.10'],
    pairing: null,
    ...over
  },
  devices: [
    { id: 'idle', name: 'IDLE-PC', address: '192.168.0.124', port: 47610, paired: true, online: true, allowWrite: false },
    { id: 'lap', name: 'LAPTOP', address: '192.168.0.50', port: 47610, paired: false, online: true }
  ]
})

let api: Record<string, ReturnType<typeof vi.fn>>

function mount(enabled: boolean, state = lanState()): void {
  api = {
    getLanState: vi.fn().mockResolvedValue(state),
    onLanChanged: vi.fn().mockReturnValue(() => {}),
    getMcpInfo: vi.fn().mockResolvedValue({
      exe: 'C:\\Apps\\baguette\\baguette.exe',
      script: 'C:\\Apps\\baguette\\resources\\app.asar.unpacked\\out\\main\\mcp.js',
      bridgeFile: 'C:\\Users\\me\\AppData\\Roaming\\baguette\\agent-bridge.json',
      bridgeOn: true
    }),
    pairLanDevice: vi.fn(),
    startLanPairing: vi.fn(),
    cancelLanPairing: vi.fn(),
    listLanTabs: vi.fn().mockResolvedValue({ tabs: [] }),
    writeClipboardText: vi.fn()
  }
  ;(window as unknown as { api: unknown }).api = api
  useApp.setState({ settings: { lanEnabled: enabled, lanDeviceName: '' } as AppSettings })
  render(<DevicesPanel />)
}

describe('DevicesPanel', () => {
  it('explains the feature and offers no pairing while LAN control is off', async () => {
    mount(false, lanState({ running: false }))
    expect(await screen.findByText(/打開右上角的「內網連線」/)).toBeTruthy()
    expect(screen.queryByText('顯示配對碼')).toBeNull()
  })

  it('shows the code while this PC accepts pairing', async () => {
    mount(true, lanState({ pairing: { code: '042517', expiresAt: Date.now() + 60_000 } }))
    expect(await screen.findByText('042517')).toBeTruthy()
  })

  it('sends a typed code to the device it was typed for, and shows why it failed', async () => {
    mount(true)
    expect(await screen.findByText('IDLE-PC')).toBeTruthy()
    api.pairLanDevice.mockRejectedValue(new Error("Error invoking remote method 'lan:pair': LanError: 配對碼不對（或已過期）"))
    fireEvent.click(screen.getByRole('button', { name: '配對' }))
    fireEvent.change(screen.getByPlaceholderText('對方畫面上的 6 位數'), { target: { value: '12a3456' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '確認' }))
    })
    expect(api.pairLanDevice).toHaveBeenCalledWith({ deviceId: 'lap' }, '123456')
    expect(await screen.findByText('配對碼不對（或已過期）')).toBeTruthy()
  })

  it('gives MCP commands that launch mcp.js with the exe as Node', async () => {
    mount(true)
    const claude = await screen.findByText(/^claude mcp add/)
    expect(claude.textContent).toBe(
      'claude mcp add baguette -s user -e ELECTRON_RUN_AS_NODE=1 -- "C:\\Apps\\baguette\\baguette.exe" "C:\\Apps\\baguette\\resources\\app.asar.unpacked\\out\\main\\mcp.js" "C:\\Users\\me\\AppData\\Roaming\\baguette\\agent-bridge.json"'
    )
    // agy rejects flags after the server name.
    expect(screen.getByText(/^agy mcp add/).textContent).toMatch(/^agy mcp add --env ELECTRON_RUN_AS_NODE=1 baguette "/)
  })
})
