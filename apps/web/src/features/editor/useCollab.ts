import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { IndexeddbPersistence } from 'y-indexeddb'
import { api } from '../../lib/api'
import {
  forgetOfflineDatabase,
  offlineDatabaseName,
  rememberOfflineDatabase,
  requestPersistentStorage,
} from '../../lib/offline'
import type { Outbox } from '../../lib/outbox'
import { markSynced, markUnsynced } from '../../lib/unsynced'
import { webSocketUrl } from '../../lib/ws'
import type { User } from '../auth/session'
import type { Role } from '../documents/api'
import { whenOnServer } from '../offline/queue'
import { useOutbox } from '../offline/useOutbox'
import { colorFor } from './colors'
import { CollabProvider, type CollabDeps, type CollabState } from './CollabProvider'

/** What the provider needs to reach one stream: a document's main text, or one branch. */
export function collabDeps(
  userId: string,
  documentId: string,
  branchId: string | null,
  outbox: Outbox | null = null,
): CollabDeps {
  return {
    getTicket: async () => {
      // A document created offline exists only on this device until the outbox sends it.
      // Asking for a ticket first would get "not found", which stops editing and deletes the
      // offline copy; so send it first, and if that cannot happen yet, retry later.
      await whenOnServer(outbox, documentId)
      return api<{ ticket: string; role: Role }>('/collab/tickets', {
        method: 'POST',
        body: { document_id: documentId, branch_id: branchId },
      })
    },
    // The ticket says which branch, if any: the socket address is the document's either way.
    socketUrl: (_stream, ticket) =>
      webSocketUrl(`/ws/docs/${documentId}?ticket=${encodeURIComponent(ticket)}`),
    openLocalStore: (doc) => {
      if (typeof indexedDB === 'undefined') return null
      const name = offlineDatabaseName(userId, doc.guid)
      rememberOfflineDatabase(name)
      const store = new IndexeddbPersistence(name, doc)
      return {
        whenSynced: store.whenSynced,
        clearData: async () => {
          await store.clearData()
          forgetOfflineDatabase(name)
        },
        destroy: () => store.destroy(),
      }
    },
  }
}

/**
 * One live provider per open document (or branch, when `branchId` is given) and user. It is
 * created during render and started by the effect; because the provider can stop and restart,
 * React's development double-mount (start, stop, start) works without recreating anything.
 */
export function useCollab(
  documentId: string,
  user: User,
  branchId: string | null = null,
  createDeps: typeof collabDeps = collabDeps,
): { provider: CollabProvider; state: CollabState } {
  const { id: userId, name: userName } = user
  const outbox = useOutbox()
  // A branch's id names its Yjs document, and so its own offline copy, apart from main's.
  const provider = useMemo(
    () =>
      new CollabProvider(branchId ?? documentId, createDeps(userId, documentId, branchId, outbox)),
    [documentId, branchId, userId, createDeps, outbox],
  )

  useEffect(() => {
    requestPersistentStorage()
    provider.setUser({ name: userName, color: colorFor(userId) })
    provider.start()
    return () => provider.stop()
  }, [provider, userId, userName])

  // Remembers edits the server has not received, so they are sent on reconnect even if this
  // editor is closed by then (ADR 0019).
  useEffect(() => {
    const stream = { documentId, branchId }
    return provider.subscribe(() => {
      const { unsynced, synced, stopReason } = provider.getSnapshot()
      // Refused: the copy is deleted and the page says so; nothing is left to send.
      if (stopReason === 'forbidden' || stopReason === 'not_found') markSynced(userId, stream)
      else if (unsynced > 0) markUnsynced(userId, stream)
      else if (synced) markSynced(userId, stream)
    })
  }, [provider, userId, documentId, branchId])

  const state = useSyncExternalStore(provider.subscribe, provider.getSnapshot)
  return { provider, state }
}
