import { api } from '../../lib/api'
import type { Role } from '../documents/api'

export type ShareRole = Exclude<Role, 'owner'>

export const SHARE_ROLES: { value: ShareRole; label: string }[] = [
  { value: 'editor', label: 'Editor' },
  { value: 'commenter', label: 'Commenter' },
  { value: 'viewer', label: 'Viewer' },
]

export const LINK_EXPIRY: { value: number | null; label: string }[] = [
  { value: 1, label: '1 day' },
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: null, label: 'Never' },
]

export interface Member {
  user: { id: string; name: string; email: string }
  role: Role
  added_at: string
}

export interface ShareLink {
  id: string
  role: Role
  created_at: string
  expires_at: string | null
}

export interface CreatedLink extends ShareLink {
  /** Shown once: the server keeps only a hash. */
  token: string
}

const base = (documentId: string) => `/documents/${documentId}`

export const sharingApi = {
  members: (documentId: string) => api<Member[]>(`${base(documentId)}/members`),
  invite: (documentId: string, email: string, role: ShareRole) =>
    api<Member>(`${base(documentId)}/members`, { method: 'POST', body: { email, role } }),
  changeRole: (documentId: string, userId: string, role: ShareRole) =>
    api<void>(`${base(documentId)}/members/${userId}`, { method: 'PATCH', body: { role } }),
  remove: (documentId: string, userId: string) =>
    api<void>(`${base(documentId)}/members/${userId}`, { method: 'DELETE' }),
  transfer: (documentId: string, userId: string) =>
    api<void>(`${base(documentId)}/transfer-ownership`, {
      method: 'POST',
      body: { user_id: userId },
    }),
  links: (documentId: string) => api<ShareLink[]>(`${base(documentId)}/links`),
  createLink: (documentId: string, role: ShareRole, expiresInDays: number | null) =>
    api<CreatedLink>(`${base(documentId)}/links`, {
      method: 'POST',
      body: { role, expires_in_days: expiresInDays },
    }),
  revokeLink: (documentId: string, linkId: string) =>
    api<void>(`${base(documentId)}/links/${linkId}`, { method: 'DELETE' }),
  // The token travels in the body, never the URL path, so it stays out of request logs.
  accept: (token: string) =>
    api<{ document_id: string; role: Role }>('/links/accept', {
      method: 'POST',
      body: { token },
    }),
}

export function shareUrl(token: string): string {
  return `${globalThis.location.origin}/share/${token}`
}
