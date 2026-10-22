import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

// A plain append-only log file in userData/logs.
//
// Until this existed, an error in the packaged app left no trace at all: the
// main process has no console anyone can see, and Electron's default reaction
// to an uncaught exception is a modal dialog followed by exit. Anything that
// goes wrong in the field — a pty that would not spawn, a settings file that
// would not parse, a renderer crash — now lands here with a timestamp, and
// 設定 has a button that opens the folder.
//
// Deliberately synchronous and dependency-free: it must work from inside an
// uncaughtException handler, when nothing else can be trusted to still run.

const MAX_BYTES = 1024 * 1024

type Level = 'info' | 'warn' | 'error'

/** Resolved lazily: app.getPath is not available at module load in tests. */
let resolveDir: () => string = () => {
  throw new Error('log.init() was not called')
}

export function initLog(dirResolver: () => string): void {
  resolveDir = dirResolver
}

export function logDir(): string {
  return resolveDir()
}

export function logFile(): string {
  return join(logDir(), 'main.log')
}

/** Render an arbitrary thrown value in one line, keeping a stack when there is one. */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ? err.stack.replace(/\s*\n\s*/g, ' | ') : `${err.name}: ${err.message}`
  }
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/**
 * Keep the file from growing without bound: once it passes MAX_BYTES it is
 * renamed to main.1.log (replacing the previous one) and a fresh file starts.
 * One generation of history is enough to see what happened before a restart.
 */
function rotateIfNeeded(file: string): void {
  try {
    if (statSync(file).size < MAX_BYTES) return
  } catch {
    return // no file yet
  }
  try {
    renameSync(file, join(logDir(), 'main.1.log'))
  } catch {
    /* if rotation fails we just keep appending; better a big log than none */
  }
}

function write(level: Level, message: string): void {
  try {
    const dir = logDir()
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'main.log')
    rotateIfNeeded(file)
    appendFileSync(file, `${new Date().toISOString()} [${level}] ${message}\n`, 'utf8')
  } catch {
    /* logging must never be the thing that throws */
  }
}

export const log = {
  info: (message: string): void => write('info', message),
  warn: (message: string): void => write('warn', message),
  error: (message: string, err?: unknown): void =>
    write('error', err === undefined ? message : `${message}: ${describeError(err)}`)
}
