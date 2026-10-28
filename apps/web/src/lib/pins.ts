import { OFFLINE_DB_PREFIX } from './offline'

const keyFor = (userId: string) => `${OFFLINE_DB_PREFIX}${userId}:pinned`
const listeners = new Set<() => void>()
const cache = new Map<string, string[]>()

/**
 * Documents someone asked to keep available offline. Opened documents get an offline copy
 * anyway; pinned ones are also downloaded ahead of time and refreshed while online.
 */
export function pinnedDocuments(userId: string): string[] {
  let pins = cache.get(userId)
  if (!pins) {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(keyFor(userId)) ?? '[]')
      pins = Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []
    } catch {
      pins = []
    }
    cache.set(userId, pins)
  }
  return pins
}

export function setPinned(userId: string, documentId: string, pinned: boolean): void {
  const current = pinnedDocuments(userId).filter((id) => id !== documentId)
  const next = pinned ? [...current, documentId] : current
  cache.set(userId, next)
  try {
    localStorage.setItem(keyFor(userId), JSON.stringify(next))
  } catch {
    // Blocked: the pin lasts for this visit only.
  }
  for (const listener of listeners) listener()
}

export function subscribePins(listener: () => void): () => void {
  listeners.add(listener)
  // Another tab pinned something.
  const onStorage = (event: StorageEvent) => {
    if (event.key?.startsWith(OFFLINE_DB_PREFIX) && event.key.endsWith(':pinned')) {
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

/** Forgets cached pins after sign-out wiped localStorage. */
export function resetPins(): void {
  cache.clear()
  for (const listener of listeners) listener()
}
