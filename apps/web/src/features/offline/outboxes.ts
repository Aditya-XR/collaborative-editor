import type { QueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { OFFLINE_DB_PREFIX, rememberOfflineDatabase } from '../../lib/offline'
import { IndexedDbStore, MemoryStore, Outbox, type OutboxEntry } from '../../lib/outbox'
import type { Thread } from '../comments/api'

// One outbox per person for the life of the page, created on first use: the editor must see a
// document's pending creation from its very first render (ADR 0019), and React may mount and
// unmount providers more than once.
const outboxes = new Map<string, Outbox>()

export function outboxFor(userId: string, queryClient: QueryClient): Outbox {
  let outbox = outboxes.get(userId)
  if (!outbox) {
    outbox = createOutbox(userId, queryClient)
    outboxes.set(userId, outbox)
  }
  return outbox
}

/** Closes every outbox: signing out is about to delete their databases. */
export function closeOutboxes(): void {
  for (const outbox of outboxes.values()) outbox.close()
  outboxes.clear()
}

function createOutbox(userId: string, queryClient: QueryClient): Outbox {
  const name = `${OFFLINE_DB_PREFIX}${userId}:outbox`
  let store
  if (typeof indexedDB === 'undefined') {
    store = new MemoryStore()
  } else {
    rememberOfflineDatabase(name) // so signing out deletes it with the documents
    store = new IndexedDbStore(name)
  }
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(name)
  ;(channel as { unref?: () => void } | null)?.unref?.()
  const locks = globalThis.navigator?.locks
  return new Outbox(store, {
    send: (entry) => api(entry.path, { method: entry.method, body: entry.body }),
    onSent: (entry, result) => showSent(queryClient, entry, result),
    onSettled: (entry) => refreshAfter(queryClient, entry),
    exclusive: locks ? (run) => locks.request(name, run) : undefined,
    channel: channel
      ? {
          post: () => {
            try {
              channel.postMessage('changed')
            } catch {
              // Closed on sign-out while a send finished: nobody is listening any more.
            }
          },
          listen: (onChange) => {
            channel.addEventListener('message', onChange)
            return () => channel.close()
          },
        }
      : undefined,
  })
}

/**
 * A sent comment comes back as its thread: show it at once, in the same moment its queued copy
 * leaves the outbox, rather than after a refetch (the panel would flicker without it).
 */
function showSent(queryClient: QueryClient, entry: OutboxEntry, result: unknown): void {
  if (entry.kind !== 'thread' && entry.kind !== 'reply') return
  const thread = result as Thread
  queryClient.setQueryData<Thread[]>(
    ['comments', entry.documentId, thread.branch_id ?? 'main'],
    (threads) => threads && [...threads.filter((t) => t.id !== thread.id), thread],
  )
}

/** What the server now says about whatever an entry changed. */
function refreshAfter(queryClient: QueryClient, entry: OutboxEntry): void {
  if (entry.kind !== 'thread' && entry.kind !== 'reply') {
    void queryClient.invalidateQueries({ queryKey: ['documents'] })
  }
  // A document created offline has no comments on the server until now, either.
  if (entry.kind !== 'rename' && entry.kind !== 'star') {
    void queryClient.invalidateQueries({ queryKey: ['comments', entry.documentId] })
  }
}
