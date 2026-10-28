import { isBrowserOnline, isReachable, isUnreachable } from '../../lib/network'
import type { Outbox, OutboxEntry } from '../../lib/outbox'

export type Sent<T> = { queued: false; result: T } | { queued: true }

/**
 * Sends a change now, or queues it in the outbox when the API is out of reach (ADR 0019). A
 * change to a document the server has not heard of yet always waits behind its creation.
 */
export async function sendOrQueue<T>(
  outbox: Outbox | null,
  entry: Omit<OutboxEntry, 'createdAt'>,
  send: () => Promise<T>,
): Promise<Sent<T>> {
  const queue = async (): Promise<Sent<T>> => {
    await outbox!.add({ ...entry, createdAt: Date.now() })
    // The browser's online event starts the next attempt; with a network but no answer from
    // the API, the outbox keeps retrying with backoff from now on.
    if (isBrowserOnline()) void outbox!.flush()
    return { queued: true }
  }
  if (outbox) {
    await outbox.ready()
    if (!isReachable() || outbox.isPendingCreate(entry.documentId)) return queue()
  }
  try {
    return { queued: false, result: await send() }
  } catch (error) {
    if (outbox && isUnreachable(error)) return queue()
    throw error
  }
}

/**
 * Resolves once the server knows the document. One created on this device while offline is sent
 * first; if that cannot happen yet, this throws the TypeError fetch throws without a network, so
 * callers treat it as "offline" (retry later), never as "not found" (which deletes local copies).
 */
export async function whenOnServer(outbox: Outbox | null, documentId: string): Promise<void> {
  if (!outbox) return
  await outbox.ready()
  // Without a network there is nothing to try; the outbox sends it when the network returns.
  if (outbox.isPendingCreate(documentId) && isBrowserOnline()) await outbox.flush()
  if (outbox.isPendingCreate(documentId)) throw new TypeError('Not on the server yet')
}
