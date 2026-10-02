import { api } from '../../lib/api'

export type BranchStatus = 'open' | 'merged' | 'closed'

export interface Branch {
  id: string
  document_id: string
  name: string
  description: string
  status: BranchStatus
  created_by: { id: string; name: string } | null
  created_at: string
  updated_at: string
  /** Set once the author asks for review: the branch is then a merge request. */
  review_requested_at: string | null
  merged_by: { id: string; name: string } | null
  merged_at: string | null
  closed_at: string | null
  can_edit: boolean
  can_merge: boolean
}

export type ChangeKind = 'added' | 'removed' | 'changed' | 'conflict'

export interface Change {
  kind: ChangeKind
  /** Text of the blocks involved: at the merge base, in main now, and in the branch. */
  base: string[]
  main: string[]
  branch: string[]
}

export interface Review {
  branch: Branch
  changes: Change[]
  conflicts: number
  /** Identifies the branch content reviewed; merging sends it back. */
  head: string
  /** Main as it would be after merging, as a base64 Yjs update. */
  preview: string
}

const base = (documentId: string) => `/documents/${documentId}/branches`

export const branchesApi = {
  list: (documentId: string) => api<Branch[]>(base(documentId)),
  get: (documentId: string, branchId: string) => api<Branch>(`${base(documentId)}/${branchId}`),
  create: (documentId: string, name: string) =>
    api<Branch>(base(documentId), { method: 'POST', body: { name } }),
  update: (
    documentId: string,
    branchId: string,
    changes: { name?: string; description?: string; review_requested?: boolean },
  ) => api<Branch>(`${base(documentId)}/${branchId}`, { method: 'PATCH', body: changes }),
  updateFromMain: (documentId: string, branchId: string) =>
    api<Branch>(`${base(documentId)}/${branchId}/update-from-main`, { method: 'POST' }),
  review: (documentId: string, branchId: string) =>
    api<Review>(`${base(documentId)}/${branchId}/review`),
  merge: (documentId: string, branchId: string, head: string) =>
    api<Branch>(`${base(documentId)}/${branchId}/merge`, { method: 'POST', body: { head } }),
  close: (documentId: string, branchId: string) =>
    api<Branch>(`${base(documentId)}/${branchId}/close`, { method: 'POST' }),
}

export const STATUS_LABEL: Record<BranchStatus, string> = {
  open: 'Open',
  merged: 'Merged',
  closed: 'Closed',
}
