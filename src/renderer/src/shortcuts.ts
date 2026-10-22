/**
 * Every keyboard shortcut the app handles, in one place, so the handler in
 * App.tsx and the table in 設定 cannot drift apart.
 *
 * The combinations follow Windows Terminal: plain Ctrl+letter chords are left
 * alone because CLIs use them (Ctrl+C interrupts, Ctrl+F is readline's
 * forward-char, Ctrl+T transposes), so tab management lives on Ctrl+Shift.
 */
export type ShortcutId =
  | 'newSession'
  | 'closeSession'
  | 'nextSession'
  | 'prevSession'
  | 'nthSession'
  | 'split'
  | 'search'
  | 'copy'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'settings'

export interface ShortcutDef {
  id: ShortcutId
  /** Human-readable keys, shown in 設定. */
  keys: string
  label: string
}

export const SHORTCUTS: ShortcutDef[] = [
  { id: 'newSession', keys: 'Ctrl+Shift+T', label: '新開 Claude session（在目前選的群組）' },
  { id: 'closeSession', keys: 'Ctrl+Shift+W', label: '關閉目前的 session' },
  { id: 'nextSession', keys: 'Ctrl+Tab', label: '切到下一個 session' },
  { id: 'prevSession', keys: 'Ctrl+Shift+Tab', label: '切到上一個 session' },
  { id: 'nthSession', keys: 'Alt+1 … Alt+9', label: '切到側欄第 N 個 session' },
  { id: 'split', keys: 'Ctrl+Shift+D', label: '分割畫面' },
  { id: 'search', keys: 'Ctrl+Shift+F', label: '在終端內搜尋' },
  { id: 'copy', keys: 'Ctrl+Shift+C', label: '複製終端選取的文字' },
  { id: 'zoomIn', keys: 'Ctrl+=', label: '終端字體放大' },
  { id: 'zoomOut', keys: 'Ctrl+-', label: '終端字體縮小' },
  { id: 'zoomReset', keys: 'Ctrl+0', label: '終端字體回預設' },
  { id: 'settings', keys: 'Ctrl+,', label: '開啟設定' }
]

/** Which shortcut (if any) a keydown is, or null. Digit for nthSession is `n`. */
export function matchShortcut(e: KeyboardEvent): { id: ShortcutId; n?: number } | null {
  const ctrl = e.ctrlKey || e.metaKey
  const key = e.key
  if (e.altKey && !ctrl && /^[1-9]$/.test(key)) return { id: 'nthSession', n: Number(key) }
  if (!ctrl || e.altKey) return null
  if (key === 'Tab') return { id: e.shiftKey ? 'prevSession' : 'nextSession' }
  if (e.shiftKey) {
    switch (key.toLowerCase()) {
      case 't':
        return { id: 'newSession' }
      case 'w':
        return { id: 'closeSession' }
      case 'd':
        return { id: 'split' }
      case 'f':
        return { id: 'search' }
      case 'c':
        return { id: 'copy' }
    }
    return null
  }
  // Ctrl+= reports as '=' on a US layout and '+' on some others; accept both.
  if (key === '=' || key === '+') return { id: 'zoomIn' }
  if (key === '-' || key === '_') return { id: 'zoomOut' }
  if (key === '0') return { id: 'zoomReset' }
  if (key === ',') return { id: 'settings' }
  return null
}
