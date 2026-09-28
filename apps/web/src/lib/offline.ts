/**
 * Every IndexedDB database this app creates is named with this prefix and listed in a registry,
 * so signing out can remove all of them: a shared computer must not keep someone's documents.
 */
export const OFFLINE_DB_PREFIX = 'collabedit:'
const REGISTRY_KEY = 'collabedit:offline-databases'

function readRegistry(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(REGISTRY_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((name) => typeof name === 'string') : []
  } catch {
    return []
  }
}

function writeRegistry(names: string[]): void {
  try {
    localStorage.setItem(REGISTRY_KEY, JSON.stringify(names))
  } catch {
    // Storage full or blocked: signing out still deletes what indexedDB.databases() reports.
  }
}

export function offlineDatabaseName(userId: string, documentId: string): string {
  // Scoped by user as well as document, so two people on one browser never share a copy.
  return `${OFFLINE_DB_PREFIX}${userId}:${documentId}`
}

export function rememberOfflineDatabase(name: string): void {
  const names = readRegistry()
  if (!names.includes(name)) writeRegistry([...names, name])
}

export function forgetOfflineDatabase(name: string): void {
  writeRegistry(readRegistry().filter((entry) => entry !== name))
}

export async function wipeOfflineDatabases(): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const names = new Set(readRegistry())
  try {
    for (const db of (await indexedDB.databases?.()) ?? []) {
      if (db.name?.startsWith(OFFLINE_DB_PREFIX)) names.add(db.name)
    }
  } catch {
    // indexedDB.databases() is missing in some browsers; the registry covers them.
  }
  await Promise.all(
    [...names].map(
      (name) =>
        new Promise<void>((resolve) => {
          const request = indexedDB.deleteDatabase(name)
          request.onsuccess = request.onerror = request.onblocked = () => resolve()
        }),
    ),
  )
  writeRegistry([])
}

/** Ask the browser not to evict offline copies when disk runs low. Best effort. */
export function requestPersistentStorage(): void {
  void navigator.storage?.persist?.().catch(() => false)
}
