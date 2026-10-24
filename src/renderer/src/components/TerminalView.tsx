import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { quoteForShell } from '../pathText'
import { useApp } from '../store/sessions'
import { matchShortcut } from '../shortcuts'

const THEME = {
  background: '#0d1117',
  foreground: '#e6edf3',
  cursor: '#e6edf3',
  selectionBackground: '#264f78',
  black: '#484f58',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#f0f6fc'
}

const SEARCH_DECORATIONS = {
  matchBackground: '#5a4a00',
  matchBorder: '#d29922',
  matchOverviewRuler: '#d29922',
  activeMatchBackground: '#a37f00',
  activeMatchBorder: '#e3b341',
  activeMatchColorOverviewRuler: '#e3b341'
}

/**
 * Fit, but only while the terminal is actually laid out.
 *
 * Inactive tabs sit under a `display: none` wrapper (App.tsx), and FitAddon
 * does not bail out there: it measures the hidden parent and proposes a
 * garbage size (9x4 seen on a tab that went to the background ~80ms after it
 * mounted), which then reaches the pty and reflows the CLI into a sliver.
 * A non-rendered element has no client box, so that is the test.
 */
function fitIfShown(host: HTMLElement | null, fit: FitAddon | null): boolean {
  if (!host || !fit || host.clientWidth === 0 || host.clientHeight === 0) return false
  fit.fit()
  return true
}

export function TerminalView({ id, active }: { id: string; active: boolean }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  // Last size actually pushed to the pty. Every resize we send raises SIGWINCH,
  // and a full-screen CLI repaints its whole UI on each one; two of those landing
  // while a repaint is still in flight is what leaves half-drawn frames stacked
  // on top of each other (stale row fragments at column 0, two status lines).
  // Fitting is idempotent but pushing is not, so only push on a real change.
  const sentRef = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 })

  const fontSize = useApp((s) => s.terminalFontSize)
  const searchRequest = useApp((s) => s.searchRequest)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ index: number; count: number } | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: "'Cascadia Code', Consolas, 'Courier New', monospace",
      fontSize: useApp.getState().terminalFontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      allowProposedApi: true,
      theme: THEME,
      scrollback: 5000
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    const search = new SearchAddon()
    term.loadAddon(search)
    // URLs a CLI prints become clickable. window.open goes through main's
    // setWindowOpenHandler, which only lets http(s) reach the OS browser.
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank')))
    term.open(host)
    let shownAtMount = false
    try {
      shownAtMount = fitIfShown(host, fit)
    } catch {
      /* not visible yet */
    }
    termRef.current = term
    fitRef.current = fit
    searchRef.current = search

    const resultsDisp = search.onDidChangeResults(({ resultIndex, resultCount }) =>
      setResults(resultCount > 0 ? { index: resultIndex + 1, count: resultCount } : { index: 0, count: 0 })
    )

    // Renderer keystrokes -> PTY. Typing into a tab is looking at it, so any
    // pending attention flag on it is stale.
    const dataDisp = term.onData((d) => {
      window.api.writeSession(id, d)
      useApp.getState().clearAttention(id)
    })

    // PTY output -> this terminal (filtered by session id).
    //
    // The main process holds a session's output until we attach, so nothing is
    // lost between spawn and this mount. Live chunks can still arrive before
    // the attach reply does, so they queue here and are written after the
    // backlog — otherwise they would appear ahead of it.
    let attached = false
    let queued: string[] = []
    const offData = window.api.onData(({ id: sid, data }) => {
      if (sid !== id) return
      if (attached) term.write(data)
      else queued.push(data)
    })
    void window.api.attachSession(id).then((backlog) => {
      if (backlog) term.write(backlog)
      for (const chunk of queued) term.write(chunk)
      queued = []
      attached = true
    })

    // Paste (e.g. pasting back a long OAuth code during login) via Electron's
    // own clipboard IPC instead of relying on the browser paste event, which
    // is flaky in a contextIsolated renderer. Handles Ctrl+V / Cmd+V.
    //
    // An image on the clipboard is spilled to a temp PNG and its path is typed
    // instead: a pty carries bytes, so handing the CLI a file it can open is
    // the only way "paste a screenshot" can work. Claude Code reads an image
    // path directly.
    //
    // Text wins when both are present. Excel, Word and browsers routinely put
    // a bitmap alongside copied text, and in that case the text is what was
    // meant — checking the image first would paste a screenshot of a
    // spreadsheet cell instead of its contents. It also avoids writing a temp
    // PNG on every ordinary paste.
    // Reading the clipboard is async, but keydown is not: holding Ctrl+V (or any
    // OS key-repeat) fires the handler again while the first read is still in
    // flight, and each one writes the clipboard to the pty. One paste per
    // gesture is what the user asked for, so ignore re-entry until it lands.
    let pasting = false
    const paste = async (): Promise<void> => {
      if (pasting) return
      pasting = true
      try {
        const text = await window.api.readClipboardText()
        if (text) {
          window.api.writeSession(id, text)
          return
        }
        const imagePath = await window.api.readClipboardImageAsFile()
        if (imagePath) window.api.writeSession(id, quoteForShell(imagePath))
      } finally {
        pasting = false
      }
    }
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'v') {
        // Returning false only tells xterm to keep its hands off this key — it
        // does NOT stop the browser, which then performs its own default paste
        // into the focused textarea. That native path is the second copy of
        // everything pasted. Killing the keydown here means it never starts,
        // which is a stronger guarantee than catching the paste event it would
        // otherwise produce (the listener below stays as a backstop for paste
        // gestures that never went through a keydown at all, e.g. the Windows
        // Shift+Insert convention or an injected editing command).
        e.preventDefault()
        e.stopImmediatePropagation()
        void paste()
        return false
      }
      // Copy has to be handled here rather than in App's global handler: only
      // this component can see the xterm selection. Everything else in
      // matchShortcut is App's, so just keep xterm from also typing it.
      const hit = matchShortcut(e)
      if (hit?.id === 'copy') {
        e.preventDefault()
        const selection = term.getSelection()
        if (selection) {
          void window.api.writeClipboardText(selection)
          term.clearSelection()
        }
        return false
      }
      if (hit) return false
      return true
    })
    // xterm registers its OWN native 'paste' listener on its hidden textarea
    // (see its addDisposableDomListener(this.textarea, 'paste', ...) call),
    // entirely separate from attachCustomKeyEventHandler above. Returning
    // false from that handler stops xterm's keydown-driven logic but does
    // NOT stop the browser from still firing a native paste event on the
    // focused textarea — so without this, Ctrl+V pasted everything twice:
    // once through our IPC-based paste() and once through xterm's own
    // handler. Capturing here, on an ancestor of that textarea, runs before
    // the target's own listener and lets us kill the event outright.
    const onNativePaste = (e: ClipboardEvent): void => {
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    host.addEventListener('paste', onNativePaste, true)
    // Right-click-to-paste, matching the classic Windows console convention.
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      void paste()
    }
    host.addEventListener('contextmenu', onContextMenu)

    // Drag a file or folder onto the terminal to type its path, the same way a
    // native terminal does. Without preventDefault the renderer would instead
    // navigate away to the dropped file.
    const onDragOver = (e: DragEvent): void => {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      host.classList.add('drop-target')
    }
    const onDragLeave = (): void => host.classList.remove('drop-target')
    const onDrop = (e: DragEvent): void => {
      e.preventDefault()
      host.classList.remove('drop-target')
      const files = [...(e.dataTransfer?.files ?? [])]
      const paths = files.map((f) => window.api.getPathForFile(f)).filter(Boolean)
      if (paths.length) {
        window.api.writeSession(id, paths.map(quoteForShell).join(' '))
        return
      }
      // Dragged text (a path from another app, a URL) still lands as text.
      const text = e.dataTransfer?.getData('text')
      if (text) window.api.writeSession(id, text)
    }
    host.addEventListener('dragover', onDragOver)
    host.addEventListener('dragleave', onDragLeave)
    host.addEventListener('drop', onDrop)

    /** Tell the pty about the current fit, but only if it actually changed. */
    const pushSize = (): void => {
      const { cols, rows } = term
      if (cols < 1 || rows < 1) return
      const last = sentRef.current
      if (last.cols === cols && last.rows === rows) return
      sentRef.current = { cols, rows }
      window.api.resizeSession(id, cols, rows)
    }

    // Mounted hidden (opened in the background): leave the pty at its spawn
    // size; the observer below pushes the real one the first time it shows.
    if (shownAtMount) {
      sentRef.current = { cols: term.cols, rows: term.rows }
      window.api.resizeSession(id, term.cols, term.rows)
    }

    // The custom font is the reason to wait: xterm measures character width at
    // open() time, so if 'Cascadia Code' is still loading it measures the
    // fallback, computes the wrong column count, and only corrects itself on
    // some later resize — mid-session, when the CLI has already drawn.
    void document.fonts?.ready.then(() => {
      if (!termRef.current) return
      try {
        if (fitIfShown(host, fit)) pushSize()
      } catch {
        /* not visible yet */
      }
    })

    // App.tsx keeps every terminal mounted and hides the inactive ones with
    // `display: none`. That fires ResizeObserver with a 0x0 box, and fitting
    // against a non-rendered element yields a garbage tiny size (~12x6) that
    // we would then push to the pty — reflowing the CLI's UI into a dozen
    // columns and permanently mangling its scrollback. Ignore those.
    //
    // Debounced because a single gesture produces a burst of boxes, not one:
    // dragging the window edge fires per frame, and splitting fires twice in a
    // row on its own (display flips none -> flex, then the pane header appears
    // and takes height away again). Only the box it settles on is worth telling
    // the pty about; the intermediate ones just make the CLI repaint into a
    // width it is about to lose.
    //
    // Being hidden also cancels a fit still waiting on the debounce: run after
    // the tab went to the background, it would measure the hidden box.
    let roTimer: number | undefined
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry?.contentRect ?? { width: 0, height: 0 }
      window.clearTimeout(roTimer)
      if (width === 0 || height === 0) return
      roTimer = window.setTimeout(() => {
        try {
          if (fitIfShown(host, fit)) pushSize()
        } catch {
          /* ignore */
        }
      }, 80)
    })
    ro.observe(host)

    return () => {
      resultsDisp.dispose()
      dataDisp.dispose()
      offData()
      host.removeEventListener('paste', onNativePaste, true)
      host.removeEventListener('contextmenu', onContextMenu)
      host.removeEventListener('dragover', onDragOver)
      host.removeEventListener('dragleave', onDragLeave)
      host.removeEventListener('drop', onDrop)
      window.clearTimeout(roTimer)
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      searchRef.current = null
    }
  }, [id])

  // Font size changes (Ctrl+= / Ctrl+- / 設定) apply live to every terminal.
  useEffect(() => {
    const term = termRef.current
    if (!term || term.options.fontSize === fontSize) return
    term.options.fontSize = fontSize
    try {
      // Hidden tabs refit when they are next shown (the observer sees the new box).
      if (!fitIfShown(hostRef.current, fitRef.current)) return
      const { cols, rows } = term
      if (cols > 0 && rows > 0 && (sentRef.current.cols !== cols || sentRef.current.rows !== rows)) {
        sentRef.current = { cols, rows }
        window.api.resizeSession(id, cols, rows)
      }
    } catch {
      /* hidden */
    }
  }, [fontSize, id])

  // Refit + focus whenever this terminal becomes the active one.
  useEffect(() => {
    if (!active) return
    const raf = requestAnimationFrame(() => {
      try {
        const t = termRef.current
        if (t && fitIfShown(hostRef.current, fitRef.current)) {
          // Same dedupe as the observer: becoming active usually settles on the
          // size this terminal already had, and re-announcing it would make the
          // CLI repaint for nothing every time you switch tabs.
          const last = sentRef.current
          if (t.cols > 0 && t.rows > 0 && (last.cols !== t.cols || last.rows !== t.rows)) {
            sentRef.current = { cols: t.cols, rows: t.rows }
            window.api.resizeSession(id, t.cols, t.rows)
          }
          if (!searchOpen) t.focus()
        }
      } catch {
        /* ignore */
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [active, id, searchOpen])

  // The global Ctrl+Shift+F bumps searchRequest; only the active terminal reacts.
  const seenRequest = useRef(searchRequest)
  useEffect(() => {
    if (searchRequest === seenRequest.current) return
    seenRequest.current = searchRequest
    if (!active) return
    setSearchOpen(true)
    // Open on the current selection when there is one, the way editors do.
    const selection = termRef.current?.getSelection()
    if (selection && !selection.includes('\n')) setQuery(selection)
    requestAnimationFrame(() => searchInputRef.current?.select())
  }, [searchRequest, active])

  const find = (q: string, direction: 'next' | 'prev', incremental = false): void => {
    const search = searchRef.current
    if (!search) return
    if (!q) {
      search.clearDecorations()
      setResults(null)
      return
    }
    const opts = { incremental, caseSensitive: false, decorations: SEARCH_DECORATIONS }
    if (direction === 'next') search.findNext(q, opts)
    else search.findPrevious(q, opts)
  }

  const closeSearch = (): void => {
    setSearchOpen(false)
    setResults(null)
    searchRef.current?.clearDecorations()
    termRef.current?.focus()
  }

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="term-host h-full w-full bg-bg-base" />
      {searchOpen && (
        <div className="absolute right-3 top-2 z-10 flex items-center gap-1 rounded-md border border-line bg-bg-panel px-2 py-1 shadow-lg">
          <input
            ref={searchInputRef}
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              find(e.target.value, 'next', true)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                find(query, e.shiftKey ? 'prev' : 'next')
              } else if (e.key === 'Escape') {
                e.preventDefault()
                closeSearch()
              } else if (matchShortcut(e.nativeEvent)?.id === 'search') {
                // Ctrl+Shift+F while already open: just keep focus here.
                e.preventDefault()
                e.stopPropagation()
                e.currentTarget.select()
              }
            }}
            placeholder="搜尋終端內容…"
            className="w-56 bg-transparent px-1 text-xs text-txt-base outline-none placeholder:text-txt-dim"
          />
          <span className="min-w-[3.5rem] text-right text-[11px] tabular-nums text-txt-dim">
            {results ? (results.count === 0 ? '沒找到' : `${results.index} / ${results.count}`) : ''}
          </span>
          <button
            onClick={() => find(query, 'prev')}
            title="上一個（Shift+Enter）"
            className="rounded px-1.5 text-xs text-txt-dim hover:bg-bg-hover hover:text-txt-base"
          >
            ↑
          </button>
          <button
            onClick={() => find(query, 'next')}
            title="下一個（Enter）"
            className="rounded px-1.5 text-xs text-txt-dim hover:bg-bg-hover hover:text-txt-base"
          >
            ↓
          </button>
          <button
            onClick={closeSearch}
            title="關閉（Esc）"
            className="rounded px-1.5 text-xs text-txt-dim hover:bg-bg-hover hover:text-txt-base"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  )
}
