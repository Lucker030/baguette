import type { AttentionReason } from '../shared/types'

// Decides, from nothing but the timing of a pty's bytes, when a session has
// finished doing something and is now waiting on the user.
//
// There is no protocol for this. A CLI does not announce "I'm done" — but
// its output does: Claude Code redraws its spinner many times a second while
// it works, a build streams lines while it compiles, and both fall silent the
// moment they stop, whether that is a finished answer, a permission prompt, or
// a shell prompt. So "output flowed for a while, then stopped" is the signal.
//
// The one thing that looks the same but isn't is the user's own typing: every
// keystroke echoes back as output, and a long message typed slowly is a long
// busy stretch that ends in silence too. Those end within a few hundred
// milliseconds of the last keystroke; a CLI's own final render lands seconds
// after the Enter that started it. `input()` records keystrokes so `settle`
// can tell the two apart.
//
// Pure logic with an injectable clock and timers so it can be tested without
// waiting real seconds. PtyManager owns one per session.

export interface ActivityCallbacks {
  onBusy(busy: boolean): void
  onAttention(reason: AttentionReason): void
}

export interface ActivityOptions {
  /** Silence this long after the last chunk ends a busy stretch. */
  quietMs: number
  /** A busy stretch shorter than this is noise (a prompt redraw), not work. */
  minBusyMs: number
  /** Output arriving within this long after a keystroke is treated as its echo. */
  echoWindowMs: number
}

export const DEFAULT_ACTIVITY_OPTIONS: ActivityOptions = {
  quietMs: 1200,
  minBusyMs: 2000,
  echoWindowMs: 400
}

interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

export class ActivityTracker {
  private busy = false
  private busyStart = 0
  private lastOutput = 0
  private lastInput = -Infinity
  private timer: unknown = null
  private disposed = false

  constructor(
    private readonly cb: ActivityCallbacks,
    private readonly opts: ActivityOptions = DEFAULT_ACTIVITY_OPTIONS,
    private readonly now: () => number = Date.now,
    private readonly timers: Timers = realTimers
  ) {}

  /** Call for every chunk the pty produces. */
  output(data: string): void {
    if (this.disposed) return
    const t = this.now()
    // BEL is the one explicit "look at me" a terminal program has. Fire it
    // immediately, independent of the idle heuristic.
    if (data.includes('\x07')) this.cb.onAttention('bell')
    if (!this.busy) {
      this.busy = true
      this.busyStart = t
      this.cb.onBusy(true)
    }
    this.lastOutput = t
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = this.timers.set(() => this.settle(), this.opts.quietMs)
  }

  /** Call for every chunk the user sends to the pty. */
  input(): void {
    if (this.disposed) return
    this.lastInput = this.now()
  }

  private settle(): void {
    this.timer = null
    if (this.disposed || !this.busy) return
    this.busy = false
    this.cb.onBusy(false)
    const stretch = this.lastOutput - this.busyStart
    if (stretch < this.opts.minBusyMs) return
    // The stretch ended on the user's own echo, not on the program's output.
    if (this.lastOutput - this.lastInput <= this.opts.echoWindowMs) return
    this.cb.onAttention('idle')
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = null
  }
}
