import { api } from '../../lib/api'

export type Role = 'owner' | 'editor' | 'commenter' | 'viewer'

export interface DocumentSummary {
  id: string
  title: string
  role: Role
  owner: { id: string; name: string }
  /** Starred by the signed-in user (stars are personal). */
  starred: boolean
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface SearchHit {
  document: DocumentSummary
  /** A passage around the matches; `match` parts are the words that matched. */
  snippet: { text: string; match: boolean }[]
}

export type DashboardView = 'all' | 'starred' | 'owned' | 'shared' | 'trash'

export const DASHBOARD_VIEWS: { value: DashboardView; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'starred', label: 'Starred' },
  { value: 'owned', label: 'Owned by me' },
  { value: 'shared', label: 'Shared with me' },
  { value: 'trash', label: 'Trash' },
]

function listQuery(view: DashboardView): string {
  return view === 'trash' ? '?trashed=true' : `?scope=${view}`
}

export const documentsApi = {
  list: (view: DashboardView) => api<DocumentSummary[]>(`/documents${listQuery(view)}`),
  get: (id: string) => api<DocumentSummary>(`/documents/${id}`),
  /** Creates a document under an id the browser chose: repeating it is harmless (ADR 0019). */
  createWithId: (id: string, title?: string) =>
    api<DocumentSummary>(`/documents/${id}`, {
      method: 'PUT',
      body: title ? { title } : undefined,
    }),
  rename: (id: string, title: string) =>
    api<DocumentSummary>(`/documents/${id}`, { method: 'PATCH', body: { title } }),
  setStarred: (id: string, starred: boolean) =>
    api<DocumentSummary>(`/documents/${id}/star`, { method: starred ? 'PUT' : 'DELETE' }),
  trash: (id: string) => api<void>(`/documents/${id}`, { method: 'DELETE' }),
  restore: (id: string) => api<DocumentSummary>(`/documents/${id}/restore`, { method: 'POST' }),
  search: (query: string, signal?: AbortSignal) =>
    api<SearchHit[]>(`/documents/search?q=${encodeURIComponent(query)}`, { signal }),
}
