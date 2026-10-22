import '../../test-utils/jsdom-env'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionInfo } from '@shared/types'
import { SessionRow } from './SessionRow'

// SessionRow carries the sidebar behaviour that is easiest to break silently
// during a refactor: double-click-to-rename, the close button not also
// selecting the tab, and the exited/error affordances.

// Vitest runs without `globals`, so testing-library's auto-cleanup never
// registers itself — unmount explicitly or renders pile up in one document.
afterEach(cleanup)

const session = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  id: 's1',
  provider: 'claude',
  cwd: 'C:\\work',
  status: 'running',
  ...over
})

function renderRow(over: Partial<Parameters<typeof SessionRow>[0]> = {}) {
  const props = {
    session: session(),
    defaultLabel: 'Claude #1',
    isActive: false,
    onSelect: vi.fn(),
    onRename: vi.fn(),
    onClose: vi.fn(),
    onDragStart: vi.fn(),
    onDragEnd: vi.fn(),
    ...over
  }
  render(<SessionRow {...props} />)
  return props
}

describe('SessionRow', () => {
  it('falls back to the default label', () => {
    renderRow()
    expect(screen.getByText('Claude #1')).toBeDefined()
  })

  it('prefers a custom name when one is set', () => {
    renderRow({ customName: 'my tab' })
    expect(screen.getByText('my tab')).toBeDefined()
  })

  it('selects on click', () => {
    const props = renderRow()
    fireEvent.click(screen.getByTitle('點兩下改名'))
    expect(props.onSelect).toHaveBeenCalledOnce()
  })

  it('closes without also selecting, so closing a background tab cannot steal focus', () => {
    const props = renderRow()
    fireEvent.click(screen.getByTitle('關閉'))

    expect(props.onClose).toHaveBeenCalledOnce()
    expect(props.onSelect).not.toHaveBeenCalled()
  })

  it('commits a rename on Enter, seeded with the current label', () => {
    const props = renderRow({ customName: 'old name' })
    fireEvent.doubleClick(screen.getByTitle('點兩下改名'))

    const input = screen.getByDisplayValue('old name')
    fireEvent.change(input, { target: { value: 'new name' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(props.onRename).toHaveBeenCalledWith('new name')
  })

  it('abandons a rename on Escape', () => {
    const props = renderRow({ customName: 'keep me' })
    fireEvent.doubleClick(screen.getByTitle('點兩下改名'))

    const input = screen.getByDisplayValue('keep me')
    fireEvent.change(input, { target: { value: 'discarded' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(props.onRename).not.toHaveBeenCalled()
    expect(screen.getByText('keep me')).toBeDefined()
  })

  it('marks an exited session', () => {
    renderRow({ session: session({ status: 'exited' }) })
    expect(screen.getByText(/已結束/)).toBeDefined()
  })

  it('marks an errored session', () => {
    renderRow({ session: session({ status: 'error' }) })
    expect(screen.getByText(/錯誤/)).toBeDefined()
  })
})
