import { describe, expect, it, vi } from 'vitest'
import {
  markSynced,
  markUnsynced,
  resetUnsynced,
  subscribeUnsynced,
  unsyncedStreams,
} from './unsynced'

describe('documents with unsent edits', () => {
  it('lists a stream once until it is synced, apart from the same document’s branches', () => {
    const changed = vi.fn()
    const stop = subscribeUnsynced(changed)
    markUnsynced('u1', { documentId: 'd1', branchId: null })
    markUnsynced('u1', { documentId: 'd1', branchId: null })
    markUnsynced('u1', { documentId: 'd1', branchId: 'b1' })

    expect(unsyncedStreams('u1')).toEqual([
      { documentId: 'd1', branchId: null },
      { documentId: 'd1', branchId: 'b1' },
    ])
    expect(unsyncedStreams('u2')).toEqual([])

    markSynced('u1', { documentId: 'd1', branchId: null })
    expect(unsyncedStreams('u1')).toEqual([{ documentId: 'd1', branchId: 'b1' }])
    expect(changed).toHaveBeenCalledTimes(3)
    stop()
  })

  it('survives a reload, so edits made offline are sent on the next visit', () => {
    markUnsynced('u1', { documentId: 'd1', branchId: null })
    resetUnsynced() // as a fresh page would start, with only localStorage
    expect(unsyncedStreams('u1')).toEqual([{ documentId: 'd1', branchId: null }])
    expect(localStorage.getItem('collabedit:u1:unsynced')).not.toBeNull()
  })
})
