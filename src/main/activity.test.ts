import { describe, expect, it } from 'vitest'
import { ActivityTracker, type ActivityOptions } from './activity'

// The idle heuristic is what lights up the sidebar and fires OS notifications.
// A false positive nags the user about their own typing; a false negative
// means a finished Claude turn goes unnoticed. Both are pinned here with a
// fake clock so the timing rules are exact rather than "usually works".

const OPTS: ActivityOptions = { quietMs: 1000, minBusyMs: 2000, echoWindowMs: 400 }

interface Harness {
  tracker: ActivityTracker
  busy: boolean[]
  attention: string[]
  /** Advance the fake clock, firing any timer that comes due. */
  advance(ms: number): void
}

function harness(): Harness {
  let now = 0
  let pending: { at: number; fn: () => void } | null = null
  const busy: boolean[] = []
  const attention: string[] = []
  const tracker = new ActivityTracker(
    {
      onBusy: (b) => busy.push(b),
      onAttention: (r) => attention.push(r)
    },
    OPTS,
    () => now,
    {
      set: (fn, ms) => {
        pending = { at: now + ms, fn }
        return pending
      },
      clear: () => {
        pending = null
      }
    }
  )
  return {
    tracker,
    busy,
    attention,
    advance(ms) {
      const target = now + ms
      while (pending && pending.at <= target) {
        const p: { at: number; fn: () => void } = pending
        now = p.at
        pending = null
        p.fn()
      }
      now = target
    }
  }
}

describe('ActivityTracker', () => {
  it('flags a session that streamed output for a while and then went quiet', () => {
    const h = harness()
    for (let i = 0; i < 30; i++) {
      h.tracker.output('spinner frame')
      h.advance(100) // 3s of steady output
    }
    expect(h.busy).toEqual([true])
    expect(h.attention).toEqual([])
    h.advance(1000) // quietMs elapses
    expect(h.busy).toEqual([true, false])
    expect(h.attention).toEqual(['idle'])
  })

  it('ignores a short burst, e.g. a prompt redraw', () => {
    const h = harness()
    h.tracker.output('$ ')
    h.advance(500)
    h.tracker.output('\x1b[2K$ ')
    h.advance(1000)
    expect(h.busy).toEqual([true, false])
    expect(h.attention).toEqual([])
  })

  it('does not flag the echo of the user typing a long message', () => {
    const h = harness()
    // 5 seconds of typing: every keystroke is input followed by its echo.
    for (let i = 0; i < 50; i++) {
      h.tracker.input()
      h.advance(20)
      h.tracker.output('x')
      h.advance(80)
    }
    h.advance(1000)
    expect(h.busy).toEqual([true, false])
    expect(h.attention).toEqual([])
  })

  it('still flags a turn that began with the user pressing Enter', () => {
    const h = harness()
    h.tracker.input() // Enter
    h.advance(50)
    for (let i = 0; i < 40; i++) {
      h.tracker.output('working…')
      h.advance(100)
    }
    // Last output is ~4s after the last input — well outside the echo window.
    h.advance(1000)
    expect(h.attention).toEqual(['idle'])
  })

  it('fires immediately on a terminal bell, independent of the idle rule', () => {
    const h = harness()
    h.tracker.output('done\x07')
    expect(h.attention).toEqual(['bell'])
    h.advance(1000)
    // The single chunk was too short to also count as an idle stretch.
    expect(h.attention).toEqual(['bell'])
  })

  it('goes silent after dispose', () => {
    const h = harness()
    for (let i = 0; i < 30; i++) {
      h.tracker.output('x')
      h.advance(100)
    }
    h.tracker.dispose()
    h.advance(5000)
    expect(h.busy).toEqual([true])
    expect(h.attention).toEqual([])
  })

  it('reports each busy stretch once, not per chunk', () => {
    const h = harness()
    for (let i = 0; i < 10; i++) {
      h.tracker.output('a')
      h.advance(50)
    }
    h.advance(1000)
    for (let i = 0; i < 10; i++) {
      h.tracker.output('b')
      h.advance(50)
    }
    h.advance(1000)
    expect(h.busy).toEqual([true, false, true, false])
  })
})
