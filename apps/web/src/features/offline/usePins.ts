import { useSyncExternalStore } from 'react'
import { pinnedDocuments, setPinned, subscribePins } from '../../lib/pins'
import { subscribeUnsynced, unsyncedStreams, type Stream } from '../../lib/unsynced'

/** The documents someone keeps available offline, and a way to change that. */
export function usePinnedDocuments(userId: string): {
  pinned: string[]
  setPinned: (documentId: string, pinned: boolean) => void
} {
  const pinned = useSyncExternalStore(subscribePins, () => pinnedDocuments(userId))
  return { pinned, setPinned: (documentId, value) => setPinned(userId, documentId, value) }
}

const NONE: Stream[] = []

/** Documents (and branches) with edits on this device the server has not received yet. */
export function useUnsyncedStreams(userId: string | null): Stream[] {
  return useSyncExternalStore(subscribeUnsynced, () => (userId ? unsyncedStreams(userId) : NONE))
}
