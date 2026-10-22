import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'

/**
 * Dedupes the "load on mount, setLoading around an await, expose a reload"
 * pattern repeated across the library screens (Skills/Hooks/Scripts).
 */
export function useLoadable<T>(
  fetcher: () => Promise<T>,
  initial: T
): { data: T; loading: boolean; reload: () => Promise<void>; setData: Dispatch<SetStateAction<T>> } {
  const [data, setData] = useState<T>(initial)
  const [loading, setLoading] = useState(true)

  const reload = async (): Promise<void> => {
    setLoading(true)
    try {
      setData(await fetcher())
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
    // Only reload automatically on mount; callers trigger subsequent reloads explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { data, loading, reload, setData }
}
