import { useEffect, useState, type ReactNode } from 'react'
import type { LanDevice, LanRemoteTab, LanState, McpInfo } from '@shared/types'
import { useApp } from '../store/sessions'
import { PROVIDER_UI } from '../providerUi'
import { LibraryHeader } from './LibraryHeader'
import { Toggle } from './Toggle'

const BTN =
  'rounded-md border border-line px-3 py-1.5 text-xs text-txt-dim hover:bg-bg-hover hover:text-txt-base disabled:cursor-not-allowed disabled:opacity-40'
const BTN_PRIMARY = 'rounded-md bg-copilot px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40'
const INPUT = 'rounded-md border border-line bg-bg-base px-2 py-1.5 text-sm outline-none focus:border-copilot'

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-medium">{title}</h2>
        {hint && <p className="mt-0.5 text-xs text-txt-dim">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

function errorText(e: unknown): string {
  // ipcRenderer.invoke wraps main's message as "Error invoking remote method '…': Error: <msg>".
  const m = e instanceof Error ? e.message : String(e)
  return m.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')
}

function Dot({ on }: { on: boolean }): JSX.Element {
  return <span className={`h-2 w-2 shrink-0 rounded-full ${on ? 'bg-green-500' : 'bg-txt-dim/40'}`} title={on ? '在線' : '離線'} />
}

// ---- this PC: name + pairing code ----

function ThisDevice({ lan }: { lan: LanState }): JSX.Element {
  const { settings, setLanDeviceName } = useApp()
  const { status } = lan
  const [name, setName] = useState(settings?.lanDeviceName ?? '')
  const [now, setNow] = useState(Date.now())
  const pairing = status.pairing

  useEffect(() => {
    if (!pairing) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [pairing])

  const left = pairing ? Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000)) : 0

  return (
    <Section
      title="這台電腦"
      hint={
        status.running
          ? `其他電腦會看到「${status.deviceName}」。位址 ${status.addresses.join('、') || '（沒有網路）'}，連接埠 ${status.port}。`
          : undefined
      }
    >
      <div className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-xs text-txt-dim">名稱</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name !== (settings?.lanDeviceName ?? '') && void setLanDeviceName(name)}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          placeholder={status.deviceName}
          maxLength={40}
          className={`${INPUT} w-64`}
        />
      </div>
      <div className="rounded-lg border border-line bg-bg-panel p-4">
        {pairing ? (
          <div className="flex items-center gap-4">
            <div>
              <div className="font-mono text-3xl tracking-[0.3em] text-txt-base">{pairing.code}</div>
              <div className="mt-1 text-xs text-txt-dim">
                在另一台電腦的「附近的裝置」選這台，輸入這組碼。{left} 秒後失效。
              </div>
            </div>
            <button onClick={() => void window.api.cancelLanPairing()} className={`${BTN} ml-auto`}>
              取消
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <span className="text-xs text-txt-dim">要讓另一台電腦控制這台？先在這裡顯示配對碼。</span>
            <button
              onClick={() => void window.api.startLanPairing()}
              disabled={!status.running}
              className={`${BTN_PRIMARY} ml-auto`}
            >
              顯示配對碼
            </button>
          </div>
        )}
      </div>
    </Section>
  )
}

// ---- a paired device ----

function RemoteTabs({ device }: { device: LanDevice }): JSX.Element {
  const [tabs, setTabs] = useState<LanRemoteTab[] | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [screen, setScreen] = useState('')

  useEffect(() => {
    let alive = true
    const load = (): void => {
      window.api.listLanTabs(device.id).then(
        (r) => {
          if (!alive) return
          setTabs(r.tabs)
          setError('')
          setSelected((s) => (s && r.tabs.some((t) => t.id === s) ? s : (r.tabs[0]?.id ?? null)))
        },
        (e: unknown) => alive && setError(errorText(e))
      )
    }
    load()
    const t = setInterval(load, 4000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [device.id])

  // The selected tab's screen, refreshed while it is on show.
  useEffect(() => {
    if (!selected) {
      setScreen('')
      return
    }
    let alive = true
    const load = (): void => {
      window.api.lanTabScreen(device.id, selected, 40).then(
        (r) => alive && setScreen(r.screen ?? ''),
        () => {}
      )
    }
    load()
    const t = setInterval(load, 1500)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [device.id, selected])

  if (error) return <div className="text-xs text-red-400">{error}</div>
  if (!tabs) return <div className="text-xs text-txt-dim">載入中…</div>
  if (!tabs.length) {
    return <div className="text-xs text-txt-dim">這台電腦的 AI 還沒有在 {device.name} 上開分頁（透過 MCP 的 baguette_open_tab）。</div>
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setSelected(t.id)}
            className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${
              selected === t.id ? 'border-copilot bg-bg-hover text-txt-base' : 'border-line text-txt-dim hover:bg-bg-hover'
            }`}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: PROVIDER_UI[t.provider]?.color }} />
            {t.name}
            {t.readOnly && <span className="text-[10px] text-txt-dim">唯讀</span>}
            {t.exited && <span className="text-[10px] text-red-400">已結束</span>}
          </button>
        ))}
      </div>
      {selected && (
        <div className="space-y-1.5">
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-black p-3 font-mono text-[11px] leading-snug text-gray-200">
            {screen || ' '}
          </pre>
          <div className="flex justify-end">
            <button onClick={() => void window.api.closeLanTab(device.id, selected)} className={BTN}>
              關閉這個分頁
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function PairedDevice({ device }: { device: LanDevice }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <li className="rounded-lg border border-line bg-bg-panel">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <button onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <span className="w-3 text-xs text-txt-dim">{open ? '▾' : '▸'}</span>
          <Dot on={device.online} />
          <span className="truncate text-sm">{device.name}</span>
          <span className="shrink-0 text-[11px] text-txt-dim">
            {device.address ?? ''}
            {device.version ? ` · v${device.version}` : ''}
          </span>
        </button>
        <label
          title="開啟後，對方可以在這台電腦開「非唯讀」的 AI 分頁：能改檔案、執行指令。只對你完全信任的電腦開啟。"
          className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-txt-dim"
        >
          <input
            type="checkbox"
            checked={device.allowWrite === true}
            onChange={(e) => void window.api.setLanAllowWrite(device.id, e.target.checked)}
            className="h-3.5 w-3.5 accent-copilot"
          />
          允許開可寫入的分頁
        </label>
        <button
          onClick={() => {
            if (confirm(`解除和「${device.name}」的配對？之後要再控制得重新配對。`)) void window.api.unpairLanDevice(device.id)
          }}
          className={BTN}
        >
          解除配對
        </button>
      </div>
      {open && (
        <div className="border-t border-line px-3 py-3">
          {device.online ? <RemoteTabs device={device} /> : <div className="text-xs text-txt-dim">離線中。</div>}
        </div>
      )}
    </li>
  )
}

// ---- nearby (unpaired) devices + add by IP ----

function NearbyDevice({ device }: { device: LanDevice }): JSX.Element {
  const [entering, setEntering] = useState(false)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const pair = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      // Success needs no handling here: the device moves to 已配對 (and the
      // store toasts) on the 'lan:paired' event.
      await window.api.pairLanDevice({ deviceId: device.id }, code)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="rounded-lg border border-line bg-bg-panel px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Dot on />
        <span className="truncate text-sm">{device.name}</span>
        <span className="text-[11px] text-txt-dim">
          {device.address}
          {device.version ? ` · v${device.version}` : ''}
        </span>
        {!entering && (
          <button onClick={() => setEntering(true)} className={`${BTN_PRIMARY} ml-auto`}>
            配對
          </button>
        )}
      </div>
      {entering && (
        <div className="mt-2 flex items-center gap-2">
          <input
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && void pair()}
            placeholder="對方畫面上的 6 位數"
            inputMode="numeric"
            className={`${INPUT} w-44 font-mono tracking-widest`}
          />
          <button onClick={() => void pair()} disabled={busy || code.length !== 6} className={BTN_PRIMARY}>
            {busy ? '配對中…' : '確認'}
          </button>
          <button onClick={() => setEntering(false)} className={BTN}>
            取消
          </button>
        </div>
      )}
      {error && <div className="mt-1.5 text-xs text-red-400">{error}</div>}
    </li>
  )
}

function AddByAddress(): JSX.Element {
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const find = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await window.api.probeLanAddress(address)
      setAddress('')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && address.trim() && void find()}
          placeholder="或輸入對方 IP，例如 192.168.0.124"
          className={`${INPUT} w-72`}
        />
        <button onClick={() => void find()} disabled={busy || !address.trim()} className={BTN}>
          {busy ? '尋找中…' : '尋找'}
        </button>
      </div>
      {error && <div className="text-xs text-red-400">{error}</div>}
    </div>
  )
}

// ---- MCP ----

function quote(p: string): string {
  return `"${p}"`
}

function McpSection(): JSX.Element {
  const [info, setInfo] = useState<McpInfo | null>(null)
  const [copied, setCopied] = useState('')
  useEffect(() => {
    void window.api.getMcpInfo().then(setInfo)
  }, [])
  if (!info) return <></>
  const args = `${quote(info.exe)} ${quote(info.script)} ${quote(info.bridgeFile)}`
  const commands = [
    { cli: 'Claude Code', cmd: `claude mcp add baguette -s user -e ELECTRON_RUN_AS_NODE=1 -- ${args}` },
    { cli: 'Codex', cmd: `codex mcp add baguette --env ELECTRON_RUN_AS_NODE=1 -- ${args}` },
    { cli: 'Antigravity', cmd: `agy mcp add --env ELECTRON_RUN_AS_NODE=1 baguette ${args}` }
  ]
  return (
    <Section
      title="給 AI 用（MCP）"
      hint="把 baguette 加成 AI CLI 的 MCP server，AI 就能用 baguette_devices、baguette_open_tab、baguette_send 等工具，在這台或已配對的電腦上開分頁、對話。在要用的那台電腦上執行一次即可。"
    >
      {!info.bridgeOn && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          MCP 透過本機的 agent bridge 運作，請先到 設定 打開「agent bridge」。
        </div>
      )}
      <ul className="space-y-2">
        {commands.map(({ cli, cmd }) => (
          <li key={cli} className="space-y-1">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-txt-base">{cli}</span>
              <button
                onClick={() => {
                  void window.api.writeClipboardText(cmd)
                  setCopied(cli)
                }}
                className="ml-auto rounded px-1.5 text-txt-dim hover:bg-bg-hover hover:text-txt-base"
              >
                {copied === cli ? '已複製' : '複製'}
              </button>
            </div>
            <code className="block break-all rounded-md border border-line bg-bg-base px-2 py-1.5 font-mono text-[11px] text-txt-dim">
              {cmd}
            </code>
          </li>
        ))}
      </ul>
    </Section>
  )
}

/**
 * 內網裝置: LAN control (main/lan.ts). Pair PCs on the same network, then an
 * AI on one can open and talk to agent tabs on another through MCP; this
 * screen shows the pairings and, read-only, what those tabs are doing.
 */
export function DevicesPanel(): JSX.Element {
  const { settings, setLanEnabled } = useApp()
  const [lan, setLan] = useState<LanState | null>(null)
  const enabled = settings?.lanEnabled ?? false

  useEffect(() => {
    void window.api.getLanState().then(setLan)
    const off = window.api.onLanChanged(setLan)
    // "Online" ages out without any event, so poll a little as well.
    const t = setInterval(() => void window.api.getLanState().then(setLan), 5000)
    return () => {
      off()
      clearInterval(t)
    }
  }, [])

  const paired = lan?.devices.filter((d) => d.paired) ?? []
  const nearby = lan?.devices.filter((d) => !d.paired) ?? []

  return (
    <div className="flex h-full flex-col">
      <LibraryHeader>
        <span className="text-sm font-medium">內網裝置</span>
        <span className="text-xs text-txt-dim">{lan?.status.running ? '已啟用' : '未啟用'}</span>
        <div className="ml-auto flex items-center gap-2 text-xs text-txt-dim">
          內網連線
          <Toggle on={enabled} onChange={(v) => void setLanEnabled(v)} />
        </div>
      </LibraryHeader>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="max-w-2xl space-y-7">
          {!enabled && (
            <div className="rounded-lg border border-dashed border-line px-4 py-5 text-xs leading-relaxed text-txt-dim">
              打開右上角的「內網連線」，同一個網路裡的 baguette 就會互相看到。配對之後，一台電腦上的 AI
              可以在另一台開 AI 分頁、傳訊息、讀回覆（預設唯讀），你在這裡看得到它在做什麼。連線全程加密，只有配對過的電腦能連。
              <br />
              第一次打開時 Windows 可能會問要不要讓 baguette 使用網路，請允許「私人網路」。
            </div>
          )}
          {lan?.status.error && (
            <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">{lan.status.error}</div>
          )}

          {enabled && lan && (
            <>
              <ThisDevice lan={lan} />

              <Section title="已配對" hint={paired.length ? '點一下展開，可以看這台電腦的 AI 在對方開的分頁。' : undefined}>
                {paired.length ? (
                  <ul className="space-y-2">
                    {paired.map((d) => (
                      <PairedDevice key={d.id} device={d} />
                    ))}
                  </ul>
                ) : (
                  <div className="text-xs text-txt-dim">還沒有配對的電腦。</div>
                )}
              </Section>

              <Section title="附近的裝置" hint="同一個網路裡開著內網連線的 baguette。">
                {nearby.length ? (
                  <ul className="space-y-2">
                    {nearby.map((d) => (
                      <NearbyDevice key={d.id} device={d} />
                    ))}
                  </ul>
                ) : (
                  <div className="text-xs text-txt-dim">還沒找到。對方也要打開內網連線；找不到的話用 IP 試試。</div>
                )}
                <AddByAddress />
              </Section>
            </>
          )}

          <McpSection />
        </div>
      </div>
    </div>
  )
}
