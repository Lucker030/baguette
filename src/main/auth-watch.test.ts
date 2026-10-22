import { describe, expect, it } from 'vitest'
import { classifyAuthOutput } from './auth-watch'

// The phrases here are what Claude Code 2.1.x actually prints (grepped from
// the binary). A miss means a stuck tab is never restarted; a false hit means
// a healthy tab gets restarted the next time anyone logs in — so both
// directions are pinned.

describe('classifyAuthOutput', () => {
  it('recognises the ways Claude Code says "sign in again"', () => {
    for (const line of [
      'OAuth token expired · Please run /login',
      'API Error: 401 Unauthorized. Run /login to sign in again, or re-authenticate your Anthropic profile',
      'The claude.ai credential is expired or revoked, and /login requires an interactive terminal',
      'Skipping: OAuth token expired and refresh failed (re-login required)',
      'Not logged in · try /login if your session expired',
      'Authentication failed. Please check your API credentials.',
      'if it keeps happening, close other Claude Code windows or sign in again with /login'
    ]) {
      expect(classifyAuthOutput(line), line).toBe('needsLogin')
    }
  })

  it('recognises a completed login', () => {
    expect(classifyAuthOutput('Login successful. Press Enter to continue…')).toBe('ok')
    expect(classifyAuthOutput('Logged in as ethan@example.com')).toBe('ok')
  })

  it('lets the later message win when both appear in one stretch', () => {
    expect(classifyAuthOutput('Please run /login\n…\nLogin successful.')).toBe('ok')
    expect(classifyAuthOutput('Login successful.\n…\nOAuth token expired · run /login')).toBe('needsLogin')
  })

  it('ignores ordinary output, including Claude merely talking about logging in', () => {
    expect(classifyAuthOutput('$ npm test\n 120 passed')).toBeNull()
    expect(classifyAuthOutput('You can use the login form on the site to authenticate users.')).toBeNull()
    expect(classifyAuthOutput('login shell started')).toBeNull()
  })
})
