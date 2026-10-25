import { describe, expect, it } from 'vitest'
import { autoApproveArgs, modeArgs } from './launch-mode'

describe('autoApproveArgs', () => {
  it("is agy's skip-permissions switch, and nothing for CLIs without one", () => {
    expect(autoApproveArgs('antigravity')).toEqual(['--dangerously-skip-permissions'])
    expect(autoApproveArgs('claude')).toEqual([])
    expect(autoApproveArgs('codex')).toEqual([])
  })
})

describe('modeArgs', () => {
  it('adds the switch only when autoApprove is on', () => {
    expect(modeArgs({ provider: 'antigravity', autoApprove: true })).toEqual(['--dangerously-skip-permissions'])
    expect(modeArgs({ provider: 'antigravity' })).toEqual([])
  })

  it('never gives a read-only tab the switch', () => {
    const args = modeArgs({ provider: 'antigravity', readOnly: true, autoApprove: true })
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args).toEqual(['--mode', 'plan', '--sandbox'])
  })
})
