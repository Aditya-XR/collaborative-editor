import { createContext, use, useSyncExternalStore } from 'react'
import type { Outbox, OutboxSnapshot } from '../../lib/outbox'
import { useAuth } from '../auth/useAuth'
import { useUnsyncedStreams } from './usePins'

export const OutboxContext = createContext<Outbox | null>(null)

const EMPTY: OutboxSnapshot = { entries: [], failures: [] }
const noop = () => () => {}

/** The signed-in person's outbox; null when signed out. */
export function useOutbox(): Outbox | null {
  return use(OutboxContext)
}

/** The changes waiting to be sent, and those the server refused, re-rendering as they change. */
export function useOutboxSnapshot(): OutboxSnapshot {
  const outbox = useOutbox()
  return useSyncExternalStore(
    outbox?.subscribe ?? noop,
    () => outbox?.getSnapshot() ?? EMPTY,
    () => EMPTY,
  )
}

/**
 * Everything made on this device the server has not received: queued requests, plus each
 * document whose text has edits waiting in its offline copy.
 */
export function usePendingChanges(): number {
  const { entries } = useOutboxSnapshot()
  const { user } = useAuth()
  return entries.length + useUnsyncedStreams(user?.id ?? null).length
}
