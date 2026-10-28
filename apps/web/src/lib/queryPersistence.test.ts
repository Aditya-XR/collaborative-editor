import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { persistQueries, restoreQueries } from './queryPersistence'

const KEY = 'collabedit:u1:queries'

describe('saved queries', () => {
  it('keeps document lists and comments, not search results, for the next offline visit', () => {
    vi.useFakeTimers()
    try {
      const client = new QueryClient()
      const stop = persistQueries(client, 'u1')
      client.setQueryData(['documents', 'list', 'all'], [{ id: 'd1' }])
      client.setQueryData(['comments', 'd1', 'main'], [{ id: 't1' }])
      client.setQueryData(['documents', 'search', 'plan'], [{ id: 'd1' }])
      vi.advanceTimersByTime(1_000)
      stop()

      const next = new QueryClient()
      restoreQueries(next, 'u1')
      expect(next.getQueryData(['documents', 'list', 'all'])).toEqual([{ id: 'd1' }])
      expect(next.getQueryData(['comments', 'd1', 'main'])).toEqual([{ id: 't1' }])
      expect(next.getQueryData(['documents', 'search', 'plan'])).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a copy that is too old, from another version, or unreadable', () => {
    const client = new QueryClient()
    const saved = (version: number, savedAt: number) =>
      JSON.stringify({ version, savedAt, state: { mutations: [], queries: [] } })

    localStorage.setItem(KEY, saved(1, 0))
    restoreQueries(client, 'u1', 40 * 24 * 60 * 60 * 1000)
    localStorage.setItem(KEY, saved(99, Date.now()))
    restoreQueries(client, 'u1')
    localStorage.setItem(KEY, '{not json')
    restoreQueries(client, 'u1')

    expect(client.getQueryCache().getAll()).toHaveLength(0)
  })

  it('removes the saved copy once the cache is cleared (signing out)', () => {
    vi.useFakeTimers()
    try {
      const client = new QueryClient()
      const stop = persistQueries(client, 'u1')
      client.setQueryData(['documents', 'list', 'all'], [])
      vi.advanceTimersByTime(1_000)
      expect(localStorage.getItem(KEY)).not.toBeNull()

      client.clear()
      client.getQueryCache().clear()
      client.setQueryData(['health'], 'ok') // not worth keeping: still "nothing saved"
      vi.advanceTimersByTime(1_000)
      stop()
      expect(localStorage.getItem(KEY)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
