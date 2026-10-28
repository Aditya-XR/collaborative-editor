import type { OutboxEntry } from '../../lib/outbox'
import type { Comment, NewThread, Person, Thread } from './api'

const PENDING = 'pending:'

/** The id a thread written offline goes by until the server gives it its own. */
export const pendingThreadId = (clientId: string) => `${PENDING}${clientId}`

function pendingComment(clientId: string, body: string, author: Person, at: number): Comment {
  return {
    id: `${PENDING}${clientId}`,
    author,
    body,
    created_at: new Date(at).toISOString(),
    edited_at: null,
    can_edit: false,
    can_delete: false,
    pending: true,
  }
}

/**
 * The server's threads plus the comments and replies written offline, which wait in the outbox
 * (ADR 0019). They are read from the outbox, not added to the cache, so no refetch can drop
 * them before they are sent. Nobody can reply to a thread the server has not seen yet: its id
 * is not known.
 */
export function withPending(
  threads: Thread[],
  entries: OutboxEntry[],
  documentId: string,
  branchId: string | null,
  author: Person,
): Thread[] {
  const ours = entries.filter(
    (entry) =>
      entry.documentId === documentId && (entry.kind === 'thread' || entry.kind === 'reply'),
  )
  // The same array when nothing is waiting: the highlights redraw only when threads change.
  if (ours.length === 0) return threads

  const replies = new Map<string, Comment[]>()
  for (const entry of ours) {
    if (entry.kind !== 'reply' || !entry.threadId) continue
    const { body, client_id } = entry.body as { body: string; client_id: string }
    const comment = pendingComment(client_id, body, author, entry.createdAt)
    replies.set(entry.threadId, [...(replies.get(entry.threadId) ?? []), comment])
  }
  const answered = threads.map((thread) => {
    const extra = replies.get(thread.id)
    return extra ? { ...thread, comments: [...thread.comments, ...extra] } : thread
  })

  const written = ours.flatMap((entry): Thread[] => {
    if (entry.kind !== 'thread') return []
    const thread = entry.body as NewThread & { branch_id: string | null }
    if ((thread.branch_id ?? null) !== branchId) return []
    return [
      {
        id: pendingThreadId(thread.client_id),
        branch_id: thread.branch_id,
        anchor_start: thread.anchor_start,
        anchor_end: thread.anchor_end,
        quoted_text: thread.quoted_text,
        created_at: new Date(entry.createdAt).toISOString(),
        resolved_at: null,
        resolved_by: null,
        comments: [pendingComment(thread.client_id, thread.body, author, entry.createdAt)],
        can_reply: false,
        pending: true,
      },
    ]
  })
  return [...answered, ...written]
}
