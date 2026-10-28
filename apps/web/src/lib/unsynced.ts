import { OFFLINE_DB_PREFIX } from './offline'

/** A document's main text, or one of its branches: each is its own Yjs stream. */
export interface Stream {
  documentId: string
  branchId: string | null
}

const keyFor = (userId: string) => `${OFFLINE_DB_PREFIX}${userId}:unsynced`
const id = ({ documentId, branchId }: Stream) =>
  branchId ? `${documentId}/${branchId}` : documentId
const listeners = new Set<() => void>()
const cache = new Map<string, Stream[]>()

/**
 * Streams with edits made on this device that the server has not received yet. Their text waits
 * in IndexedDB; this list is how the app knows to send it on reconnect even when no editor has
 * them open (ADR 0019). Kept in localStorage, so it survives a reload made offline.
 */
export function unsyncedStreams(userId: string): Stream[] {
  let streams = cache.get(userId)
  if (!streams) {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(keyFor(userId)) ?? '[]')
      streams = Array.isArray(parsed)
        ? parsed.filter(
            (s): s is Stream =>
              typeof s?.documentId === 'string' &&
              (s.branchId === null || typeof s.branchId === 'string'),
          )
        : []
    } catch {
      streams = []
    }
    cache.set(userId, streams)
  }
  return streams
}

function write(userId: string, streams: Stream[]): void {
  cache.set(userId, streams)
  try {
    localStorage.setItem(keyFor(userId), JSON.stringify(streams))
  } catch {
    // Blocked: this visit still knows; the next one finds the edits when the document opens.
  }
  for (const listener of listeners) listener()
}

export function markUnsynced(userId: string, stream: Stream): void {
  const streams = unsyncedStreams(userId)
  if (!streams.some((s) => id(s) === id(stream))) write(userId, [...streams, stream])
}

export function markSynced(userId: string, stream: Stream): void {
  const streams = unsyncedStreams(userId)
  if (streams.some((s) => id(s) === id(stream))) {
    write(
      userId,
      streams.filter((s) => id(s) !== id(stream)),
    )
  }
}

export function subscribeUnsynced(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key?.startsWith(OFFLINE_DB_PREFIX) && event.key.endsWith(':unsynced')) {
      cache.clear()
      listener()
    }
  }
  globalThis.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    globalThis.removeEventListener('storage', onStorage)
  }
}

/** Forgets the cached list after sign-out wiped localStorage. */
export function resetUnsynced(): void {
  cache.clear()
  for (const listener of listeners) listener()
}
