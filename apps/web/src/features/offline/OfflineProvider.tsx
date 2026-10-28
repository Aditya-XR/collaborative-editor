import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import { api, apiReachability } from '../../lib/api'
import { isBrowserOnline, isReachable } from '../../lib/network'
import { pinnedDocuments, subscribePins } from '../../lib/pins'
import { unsyncedStreams } from '../../lib/unsynced'
import { persistQueries, restoreQueries } from '../../lib/queryPersistence'
import { useAuth } from '../auth/useAuth'
import type { DocumentSummary } from '../documents/api'
import { outboxFor } from './outboxes'
import { OutboxContext } from './useOutbox'

/** How often to ask whether an API that stopped answering is back. */
const PROBE_INTERVAL_MS = 20_000

/**
 * Everything that lets the app work without a connection, for whoever is signed in: the outbox
 * of changes waiting to be sent, the saved document lists and comments, and the documents kept
 * available offline (ADR 0019).
 */
export function OfflineProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const userId = user?.id ?? null
  const queryClient = useQueryClient()
  const outbox = userId ? outboxFor(userId, queryClient) : null
  const [restoredFor, setRestoredFor] = useState<string | null>(null)

  // Saved lists load before the pages below first render, so they show offline at once.
  if (userId && restoredFor !== userId) {
    restoreQueries(queryClient, userId)
    setRestoredFor(userId)
  }

  useEffect(() => {
    if (!userId) return
    return persistQueries(queryClient, userId)
  }, [queryClient, userId])

  // Send what is waiting now, when the network returns, and when the API answers again.
  useEffect(() => {
    if (!outbox) return
    const flush = () => {
      if (isReachable()) void outbox.flush()
    }
    void outbox.ready().then(flush)
    globalThis.addEventListener('online', flush)
    const stop = apiReachability.subscribe(flush)
    return () => {
      globalThis.removeEventListener('online', flush)
      stop()
    }
  }, [outbox])

  // A server that went down says nothing when it comes back: ask now and then, and only then.
  useEffect(() => {
    if (!userId) return
    const timer = setInterval(() => {
      if (isBrowserOnline() && !apiReachability.isReachable()) {
        void api('/healthz', { auth: false }).catch(() => null)
      }
    }, PROBE_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [userId])

  // Back online: send the edits waiting on this device, documents no editor has open included,
  // then download pinned documents and keep them fresh, one at a time. The code that does it
  // brings Yjs with it, so it loads only when there is something to do: the dashboard's first
  // load stays free of the editor's libraries.
  useEffect(() => {
    if (!userId) return
    let cancel = () => {}
    let stopped = false
    let wasReachable = isReachable()
    const refresh = () => {
      cancel()
      const work = { pinned: pinnedDocuments(userId), unsynced: unsyncedStreams(userId) }
      if (!isReachable() || work.pinned.length + work.unsynced.length === 0) return
      let cancelled = false
      cancel = () => {
        cancelled = true
      }
      void import('./sync').then(({ keepAvailableOffline }) => {
        if (cancelled || stopped) return
        cancel = keepAvailableOffline(userId, work, queryClient, outbox, ({ documentId }) => {
          const title = queryClient.getQueryData<DocumentSummary>([
            'documents',
            'one',
            documentId,
          ])?.title
          outbox?.reportFailure(
            `Edits to “${title ?? 'a document'}”`,
            'Your access was removed or the document was deleted, so its copy on this device was too.',
          )
        })
      })
    }
    const onReachability = () => {
      const now = isReachable()
      if (now && !wasReachable) refresh()
      wasReachable = now
    }
    refresh()
    const stopPins = subscribePins(refresh)
    const stopReachability = apiReachability.subscribe(onReachability)
    globalThis.addEventListener('online', refresh)
    return () => {
      stopped = true
      cancel()
      stopPins()
      stopReachability()
      globalThis.removeEventListener('online', refresh)
    }
  }, [queryClient, userId, outbox])

  return <OutboxContext value={outbox}>{children}</OutboxContext>
}
