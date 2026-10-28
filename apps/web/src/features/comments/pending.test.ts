import { describe, expect, it } from 'vitest'
import type { OutboxEntry } from '../../lib/outbox'
import type { Thread } from './api'
import { pendingThreadId, withPending } from './pending'

const ADA = { id: 'u-ada', name: 'Ada' }

const serverThread: Thread = {
  id: 't1',
  branch_id: null,
  anchor_start: 'AQ==',
  anchor_end: 'Ag==',
  quoted_text: 'budget',
  created_at: '2026-10-28T10:00:00Z',
  resolved_at: null,
  resolved_by: null,
  comments: [],
  can_reply: true,
}

function threadEntry(clientId: string, branchId: string | null, documentId = 'd1'): OutboxEntry {
  return {
    kind: 'thread',
    documentId,
    method: 'POST',
    path: `/documents/${documentId}/threads`,
    body: {
      client_id: clientId,
      anchor_start: 'Aw==',
      anchor_end: 'BA==',
      quoted_text: 'ten',
      body: 'Too low?',
      branch_id: branchId,
    },
    label: 'Comment',
    createdAt: Date.parse('2026-10-28T11:00:00Z'),
  }
}

const replyEntry: OutboxEntry = {
  kind: 'reply',
  documentId: 'd1',
  threadId: 't1',
  method: 'POST',
  path: '/documents/d1/threads/t1/comments',
  body: { body: 'Checked.', client_id: 'c-reply' },
  label: 'Reply',
  createdAt: 0,
}

describe('withPending', () => {
  it('adds threads written offline to the stream they were written on', () => {
    const threads = withPending(
      [serverThread],
      [threadEntry('c1', null), threadEntry('c2', 'branch-1'), threadEntry('c3', null, 'd2')],
      'd1',
      null,
      ADA,
    )

    expect(threads.map((t) => t.id)).toEqual(['t1', pendingThreadId('c1')])
    const pending = threads[1]!
    expect(pending).toMatchObject({ pending: true, can_reply: false, quoted_text: 'ten' })
    expect(pending.comments).toMatchObject([{ body: 'Too low?', author: ADA, pending: true }])
    expect(pending.comments[0]!.can_edit || pending.comments[0]!.can_delete).toBe(false)
  })

  it('adds replies written offline to their thread', () => {
    const [thread] = withPending([serverThread], [replyEntry], 'd1', null, ADA)
    expect(thread!.comments).toMatchObject([{ body: 'Checked.', pending: true }])
  })

  it('changes nothing when no comment is waiting', () => {
    const threads = [serverThread]
    expect(withPending(threads, [], 'd1', null, ADA)).toBe(threads)
    const rename = { ...replyEntry, kind: 'rename' as const, threadId: undefined }
    expect(withPending(threads, [rename], 'd1', null, ADA)).toBe(threads)
  })
})
