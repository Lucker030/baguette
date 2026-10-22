import { unwatchFile, watchFile, type Stats } from 'node:fs'

// Keeping several Claude Code tabs signed in at once.
//
// Every `claude` process holds its own copy of the OAuth tokens in memory.
// When the access token expires each process refreshes on its own, and a
// refresh rotates the refresh token — so the first tab to refresh quietly
// invalidates the refresh token every other tab is still holding. Those tabs
// then fail their own refresh and stop with "run /login". Claude Code's own
// error text admits as much ("if it keeps happening, close other Claude Code
// windows or sign in again with /login"). Left alone, the user ends up
// logging in once per tab.
//
// The app can't fix the race, but it can make one login enough: watch each
// tab's output for the "sign in again" message, watch the account's
// .credentials.json for the write that a successful /login produces, and when
// that write lands restart every tab that was stuck — on its own conversation
// id, so nothing is lost but the scrollback. pty-manager.ts owns the restart;
// this module owns the two detectors.

/**
 * Output that means this tab can no longer talk to the API until someone
 * signs in. Every phrase was pulled from the Claude Code binary's own strings
 * (2.1.x), so matching is on what it actually prints, not a guess.
 */
const AUTH_NEEDED_RE =
  /(?:OAuth token (?:has )?expired|token expired or revoked|credential is expired or revoked|(?:Please )?[Rr]un \/login|sign in (?:again )?with \/login|try \/login if your session expired|Not logged in\b|Authentication failed|Authentication required\b|re-login required)/

/** Output that means a sign-in just completed in this tab. */
const AUTH_OK_RE = /(?:Login successful|Logged in as\b|Account changed via \/login)/

export type AuthVerdict = 'needsLogin' | 'ok'

/**
 * Classify a stretch of (ANSI-stripped) terminal output. A later "Login
 * successful" wins over an earlier "run /login" in the same stretch, since
 * the stretch is read in order and the login is the most recent fact.
 */
export function classifyAuthOutput(text: string): AuthVerdict | null {
  const needed = text.search(AUTH_NEEDED_RE)
  const ok = text.search(AUTH_OK_RE)
  if (needed === -1 && ok === -1) return null
  if (ok === -1) return 'needsLogin'
  if (needed === -1) return 'ok'
  return ok > needed ? 'ok' : 'needsLogin'
}

/** How much trailing output to keep so a message split across chunks still matches. */
export const AUTH_TAIL_KEEP = 300

/**
 * Watch a credentials file for writes. Stat-polled (`watchFile`) for the
 * same reasons todos.ts gives: event-based watching loses the inode on an
 * atomic replace, and for the default account the file lives on a
 * `\\wsl.localhost\...` UNC path where change events do not arrive at all.
 * Several writes land during one login (token, then profile), so the
 * callback is debounced to fire once per login rather than per write.
 */
export function watchCredentials(
  path: string,
  onChanged: () => void,
  opts: { intervalMs?: number; debounceMs?: number } = {}
): () => void {
  const interval = opts.intervalMs ?? 2000
  const debounce = opts.debounceMs ?? 3000
  let timer: ReturnType<typeof setTimeout> | null = null
  const onStat = (curr: Stats, prev: Stats): void => {
    if (curr.mtimeMs === 0) return // still absent
    if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      onChanged()
    }, debounce)
  }
  watchFile(path, { interval }, onStat)
  return () => {
    if (timer) clearTimeout(timer)
    unwatchFile(path, onStat)
  }
}
