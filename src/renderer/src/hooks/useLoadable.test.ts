import '../test-utils/jsdom-env'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useLoadable } from './useLoadable'

// Vitest runs without `globals`, so testing-library's auto-cleanup never
// registers itself.
afterEach(cleanup)

describe('useLoadable', () => {
  it('starts loading, then exposes the fetched data', async () => {
    const fetcher = vi.fn(async () => ['a', 'b'])
    const { result } = renderHook(() => useLoadable<string[]>(fetcher, []))

    expect(result.current.loading).toBe(true)
    expect(result.current.data).toEqual([])

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.data).toEqual(['a', 'b'])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('refetches on reload', async () => {
    let n = 0
    const fetcher = vi.fn(async () => [`call-${++n}`])
    const { result } = renderHook(() => useLoadable<string[]>(fetcher, []))

    await waitFor(() => expect(result.current.data).toEqual(['call-1']))
    await act(async () => {
      await result.current.reload()
    })

    expect(result.current.data).toEqual(['call-2'])
    expect(result.current.loading).toBe(false)
  })

  it('clears the loading flag and rethrows when the fetch rejects', async () => {
    let shouldFail = false
    const fetcher = vi.fn(async () => {
      if (shouldFail) throw new Error('ipc blew up')
      return ['ok']
    })
    const { result } = renderHook(() => useLoadable<string[]>(fetcher, []))
    await waitFor(() => expect(result.current.data).toEqual(['ok']))

    // The rejection is not swallowed — it reaches the caller, which in the app
    // means the global unhandledrejection listener turns it into a toast.
    shouldFail = true
    await act(async () => {
      await expect(result.current.reload()).rejects.toThrow('ipc blew up')
    })

    expect(result.current.loading).toBe(false)
    expect(result.current.data).toEqual(['ok'])
  })

  it('lets callers patch data directly without a refetch', async () => {
    const fetcher = vi.fn(async () => ['server'])
    const { result } = renderHook(() => useLoadable<string[]>(fetcher, []))
    await waitFor(() => expect(result.current.data).toEqual(['server']))

    act(() => result.current.setData(['patched']))

    expect(result.current.data).toEqual(['patched'])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
