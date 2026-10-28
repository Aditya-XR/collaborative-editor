import type { QueryClient } from '@tanstack/react-query'
import type { Outbox } from '../../lib/outbox'
import { markSynced, type Stream } from '../../lib/unsynced'
import { commentsApi } from '../comments/api'
import { documentsApi } from '../documents/api'
import { CollabProvider, type StopReason } from '../editor/CollabProvider'
import { collabDeps } from '../editor/useCollab'

const FRESH_FOR_MS = 10 * 60 * 1000
const GIVE_UP_AFTER_MS = 20_000
/** When each stream was last brought up to date, by this tab. */
const lastSynced = new Map<string, number>()

const streamKey = ({ documentId, branchId }: Stream) => branchId ?? documentId

/**
 * Connects without an editor until this device and the server hold the same text: the server's
 * copy reaches the offline copy, and edits made here reach the server. Resolves with why it
 * stopped, if the server refused it.
 */
function syncOnce(
  userId: string,
  stream: Stream,
  signal: AbortSignal,
  outbox: Outbox | null,
): Promise<StopReason | null> {
  const { documentId, branchId } = stream
  const provider = new CollabProvider(
    branchId ?? documentId,
    collabDeps(userId, documentId, branchId, outbox),
  )
  // Invisible: no cursor or avatar for anyone else to see.
  provider.awareness.setLocalState(null)
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      unsubscribe()
      signal.removeEventListener('abort', finish)
      const { status, stopReason } = provider.getSnapshot()
      provider.stop()
      resolve(status === 'stopped' ? stopReason : null)
    }
    const timer = setTimeout(finish, GIVE_UP_AFTER_MS)
    const unsubscribe = provider.subscribe(() => {
      const { synced, status, unsynced } = provider.getSnapshot()
      if (synced && unsynced === 0) {
        lastSynced.set(streamKey(stream), Date.now())
        markSynced(userId, stream)
      }
      if (synced || status === 'stopped') finish()
    })
    signal.addEventListener('abort', finish)
    provider.start()
  })
}

export interface Sync {
  /** Pinned: downloaded ahead of time, with their summary and comments. */
  pinned: string[]
  /** Edited on this device and not yet sent: always synced, however fresh they look. */
  unsynced: Stream[]
}

/**
 * Brings documents up to date one at a time: those with edits waiting on this device first, then
 * the pinned ones, so they open offline later. `onRefused` hears of a stream whose offline edits
 * the server would not take (access removed, document deleted); its local copy is gone by then.
 * Returns a function that stops after the current one.
 */
export function keepAvailableOffline(
  userId: string,
  { pinned, unsynced }: Sync,
  queryClient: QueryClient,
  outbox: Outbox | null,
  onRefused: (stream: Stream, reason: StopReason) => void = () => {},
): () => void {
  const controller = new AbortController()
  const waiting = new Set(unsynced.map(streamKey))
  const streams: Stream[] = [
    ...unsynced,
    ...pinned
      .filter((documentId) => !waiting.has(documentId))
      .map((documentId) => ({ documentId, branchId: null })),
  ]
  void (async () => {
    for (const stream of streams) {
      if (controller.signal.aborted) return
      const fresh = Date.now() - (lastSynced.get(streamKey(stream)) ?? 0) < FRESH_FOR_MS
      if (fresh && !waiting.has(streamKey(stream))) continue
      if (outbox?.isPendingCreate(stream.documentId)) continue // sent by the outbox first
      const refused = await syncOnce(userId, stream, controller.signal, outbox)
      if (refused === 'forbidden' || refused === 'not_found') {
        markSynced(userId, stream) // nothing left to send: the copy was deleted
        if (waiting.has(streamKey(stream))) onRefused(stream, refused)
      }
      if (stream.branchId || !pinned.includes(stream.documentId)) continue
      // Saved by the query persistence like anything else the app fetched.
      await Promise.allSettled([
        queryClient.prefetchQuery({
          queryKey: ['documents', 'one', stream.documentId],
          queryFn: () => documentsApi.get(stream.documentId),
        }),
        queryClient.prefetchQuery({
          queryKey: ['comments', stream.documentId, 'main'],
          queryFn: () => commentsApi.list(stream.documentId, null),
        }),
      ])
    }
  })()
  return () => controller.abort()
}
