import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeError, initLog, log, logFile } from './log'

// The log is the only trace a field failure leaves, so it has to be robust in
// exactly the situations where everything else is failing: a directory that
// doesn't exist yet, a file that has grown large, a non-Error thrown value.

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lp-log-'))
  initLog(() => join(root, 'logs'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('log', () => {
  it('creates the directory on first write and appends timestamped lines', () => {
    expect(existsSync(join(root, 'logs'))).toBe(false)
    log.info('hello')
    log.warn('careful')
    const lines = readFileSync(logFile(), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[info\] hello$/)
    expect(lines[1]).toMatch(/\[warn\] careful$/)
  })

  it('folds an Error stack onto one line so each entry stays one line', () => {
    log.error('boom', new Error('kaboom'))
    const content = readFileSync(logFile(), 'utf8')
    expect(content.trim().split('\n')).toHaveLength(1)
    expect(content).toContain('[error] boom: Error: kaboom')
  })

  it('rotates once the file passes 1 MB, keeping one older generation', () => {
    log.info('first')
    // Inflate the current file past the limit by hand.
    writeFileSync(logFile(), 'x'.repeat(1024 * 1024 + 1))
    log.info('after rotation')
    expect(statSync(logFile()).size).toBeLessThan(1024)
    expect(readFileSync(logFile(), 'utf8')).toContain('after rotation')
    expect(statSync(join(root, 'logs', 'main.1.log')).size).toBeGreaterThan(1024 * 1024)
  })
})

describe('describeError', () => {
  it('handles strings, objects and Errors', () => {
    expect(describeError('plain')).toBe('plain')
    expect(describeError({ code: 'EPERM' })).toBe('{"code":"EPERM"}')
    expect(describeError(new TypeError('bad'))).toContain('TypeError: bad')
  })
})
