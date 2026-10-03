import { api } from '../../lib/api'

export interface Person {
  id: string
  name: string
}

export interface Comment {
  id: string
  /** Null once the author's account is deleted. */
  author: Person | null
  body: string
  created_at: string
  edited_at: string | null
  can_edit: boolean
  can_delete: boolean
}

export interface Thread {
  id: string
  branch_id: string | null
  /** Encoded Yjs relative positions (base64): where the commented passage starts and ends. */
  anchor_start: string
  anchor_end: string
  /** The passage as it read when the thread was opened. */
  quoted_text: string
  created_at: string
  resolved_at: string | null
  resolved_by: Person | null
  comments: Comment[]
  can_reply: boolean
}

export interface NewThread {
  anchor_start: string
  anchor_end: string
  quoted_text: string
  body: string
}

const base = (documentId: string) => `/documents/${documentId}`

export const commentsApi = {
  list: (documentId: string, branchId: string | null) =>
    api<Thread[]>(
      `${base(documentId)}/threads${branchId ? `?branch_id=${encodeURIComponent(branchId)}` : ''}`,
    ),
  create: (documentId: string, branchId: string | null, thread: NewThread) =>
    api<Thread>(`${base(documentId)}/threads`, {
      method: 'POST',
      body: { ...thread, branch_id: branchId },
    }),
  reply: (documentId: string, threadId: string, body: string) =>
    api<Thread>(`${base(documentId)}/threads/${threadId}/comments`, {
      method: 'POST',
      body: { body },
    }),
  setResolved: (documentId: string, threadId: string, resolved: boolean) =>
    api<Thread>(`${base(documentId)}/threads/${threadId}`, {
      method: 'PATCH',
      body: { resolved },
    }),
  edit: (documentId: string, commentId: string, body: string) =>
    api<Thread>(`${base(documentId)}/comments/${commentId}`, { method: 'PATCH', body: { body } }),
  remove: (documentId: string, commentId: string) =>
    api<void>(`${base(documentId)}/comments/${commentId}`, { method: 'DELETE' }),
}
