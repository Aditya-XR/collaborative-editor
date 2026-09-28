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

export function collabDeps(userId: string): CollabDeps {
  return {
    getTicket: (documentId) =>
      api<{ ticket: string; role: Role }>('/collab/tickets', {
        method: 'POST',
        body: { document_id: documentId },
      }),
    socketUrl: (documentId, ticket) =>
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
 * One live provider per open document and user. It is created during render and started by
 * the effect; because the provider can stop and restart, React's development double-mount
 * (start, stop, start) works without recreating anything.
 */
export function useCollab(
  documentId: string,
  user: User,
  createDeps: (userId: string) => CollabDeps = collabDeps,
): { provider: CollabProvider; state: CollabState } {
  const { id: userId, name: userName } = user
  const provider = useMemo(
    () => new CollabProvider(documentId, createDeps(userId)),
    [documentId, userId, createDeps],
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
