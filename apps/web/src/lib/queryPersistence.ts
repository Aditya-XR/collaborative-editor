import { dehydrate, hydrate, type Query, type QueryClient } from '@tanstack/react-query'
import { OFFLINE_DB_PREFIX } from './offline'

// Bump when the shape of saved data changes, so an old copy is ignored rather than misread.
const VERSION = 1
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const SAVE_DELAY_MS = 1_000

interface Saved {
  version: number
  savedAt: number
  state: ReturnType<typeof dehydrate>
}

const keyFor = (userId: string) => `${OFFLINE_DB_PREFIX}${userId}:queries`

/** Document lists and summaries, and comment threads: what the app needs to open offline.
 * Search results are left out: they are only useful with the server. */
function worthKeeping(query: Query): boolean {
  if (query.state.status !== 'success') return false
  const [root, kind] = query.queryKey
  return (root === 'documents' && kind !== 'search') || root === 'comments'
}

/** Loads what an earlier visit saved, so the dashboard and comments show offline. */
export function restoreQueries(client: QueryClient, userId: string, now = Date.now()): void {
  try {
    const saved = JSON.parse(localStorage.getItem(keyFor(userId)) ?? 'null') as Saved | null
    if (!saved || saved.version !== VERSION || now - saved.savedAt > MAX_AGE_MS) return
    // Hydrating never replaces data newer than what was saved.
    hydrate(client, saved.state)
  } catch {
    // Unreadable or blocked: start empty, as without saving.
  }
}

/** Saves those queries whenever they change (at most once a second). Returns a stop function. */
export function persistQueries(client: QueryClient, userId: string): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const save = () => {
    timer = null
    const state = dehydrate(client, { shouldDehydrateQuery: worthKeeping })
    const saved: Saved = { version: VERSION, savedAt: Date.now(), state }
    try {
      // Nothing worth keeping (the cache was just cleared by signing out): keep nothing.
      if (state.queries.length === 0) localStorage.removeItem(keyFor(userId))
      else localStorage.setItem(keyFor(userId), JSON.stringify(saved))
    } catch {
      // Full or blocked: the live cache still works; it just will not open offline.
    }
  }
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' && event.type !== 'removed') return
    timer ??= setTimeout(save, SAVE_DELAY_MS)
  })
  return () => {
    unsubscribe()
    if (timer) {
      clearTimeout(timer)
      save() // keep the last changes
    }
  }
}
