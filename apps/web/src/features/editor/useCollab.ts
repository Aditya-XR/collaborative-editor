import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { IndexeddbPersistence } from 'y-indexeddb'
import { api } from '../../lib/api'
import {
  forgetOfflineDatabase,
  offlineDatabaseName,
  rememberOfflineDatabase,
  requestPersistentStorage,
} from '../../lib/offline'
import { webSocketUrl } from '../../lib/ws'
import type { User } from '../auth/session'
import type { Role } from '../documents/api'
import { colorFor } from './colors'
import { CollabProvider, type CollabDeps, type CollabState } from './CollabProvider'

/** What the provider needs to reach one stream: a document's main text, or one branch. */
export function collabDeps(
  userId: string,
  documentId: string,
  branchId: string | null,
): CollabDeps {
  return {
    getTicket: () =>
      api<{ ticket: string; role: Role }>('/collab/tickets', {
        method: 'POST',
        body: { document_id: documentId, branch_id: branchId },
      }),
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
  // A branch's id names its Yjs document, and so its own offline copy, apart from main's.
  const provider = useMemo(
    () => new CollabProvider(branchId ?? documentId, createDeps(userId, documentId, branchId)),
    [documentId, branchId, userId, createDeps],
  )

  useEffect(() => {
    requestPersistentStorage()
    provider.setUser({ name: userName, color: colorFor(userId) })
    provider.start()
    return () => provider.stop()
  }, [provider, userId, userName])

  const state = useSyncExternalStore(provider.subscribe, provider.getSnapshot)
  return { provider, state }
}
