import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PersistedTab, SessionSnapshot } from '../shared/types'
import { writeFileAtomic } from './atomic-write'

// Persist the set of open session tabs so the app can reopen them on the next
// launch. We never serialize pty/terminal state — restoring re-spawns each CLI
// and resumes its own conversation history (--resume / --continue). Kept in a
// separate file from settings.json so this frequently-rewritten blob can't
// corrupt or bloat the settings, and a parse failure here stays isolated.

function snapshotPath(): string {
  return join(app.getPath('userData'), 'sessions.json')
}

const EMPTY: SessionSnapshot = { tabs: [], activeIndex: 0 }

let cache: SessionSnapshot | null = null

function normalizeTab(t: Partial<PersistedTab>): PersistedTab | null {
  if (!t || typeof t.provider !== 'string') return null
  return {
    provider: t.provider,
    cwd: typeof t.cwd === 'string' ? t.cwd : '',
    groupId: typeof t.groupId === 'string' ? t.groupId : null,
    name: typeof t.name === 'string' ? t.name : undefined,
    accountId: typeof t.accountId === 'string' ? t.accountId : undefined,
    claudeSessionId: typeof t.claudeSessionId === 'string' ? t.claudeSessionId : undefined
  }
}

export function getSnapshot(): SessionSnapshot {
  if (cache) return cache
  try {
    const raw = readFileSync(snapshotPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<SessionSnapshot>
    const tabs = Array.isArray(parsed.tabs)
      ? parsed.tabs.map(normalizeTab).filter((t): t is PersistedTab => t !== null)
      : []
    const activeIndex =
      typeof parsed.activeIndex === 'number' && parsed.activeIndex >= 0 && parsed.activeIndex < tabs.length
        ? parsed.activeIndex
        : 0
    cache = { tabs, activeIndex }
  } catch {
    cache = { ...EMPTY }
  }
  return cache
}

export function saveSnapshot(snap: SessionSnapshot): void {
  const tabs = Array.isArray(snap?.tabs)
    ? snap.tabs.map(normalizeTab).filter((t): t is PersistedTab => t !== null)
    : []
  const activeIndex =
    typeof snap?.activeIndex === 'number' && snap.activeIndex >= 0 && snap.activeIndex < tabs.length
      ? snap.activeIndex
      : 0
  cache = { tabs, activeIndex }
  try {
    writeFileAtomic(snapshotPath(), JSON.stringify(cache, null, 2))
  } catch {
    /* best-effort; keep in-memory cache regardless */
  }
}
