import { api } from '../../lib/api'
import { formatDateTime } from '../../lib/time'

export type VersionKind = 'auto' | 'named' | 'pre_restore' | 'pre_merge'

export interface Version {
  id: string
  kind: VersionKind
  label: string | null
  created_at: string
  created_by: { id: string; name: string } | null
  restored_from: { id: string; label: string | null; created_at: string } | null
}

export interface VersionDetail extends Version {
  /** The whole document at this version: a base64 Yjs update. */
  state: string
}

const base = (documentId: string) => `/documents/${documentId}/versions`

export const versionsApi = {
  list: (documentId: string) => api<Version[]>(base(documentId)),
  get: (documentId: string, versionId: string) =>
    api<VersionDetail>(`${base(documentId)}/${versionId}`),
  save: (documentId: string, label: string) =>
    api<Version>(base(documentId), { method: 'POST', body: { label } }),
  rename: (documentId: string, versionId: string, label: string | null) =>
    api<Version>(`${base(documentId)}/${versionId}`, { method: 'PATCH', body: { label } }),
  /** Saves the current text as a version before a restore, so the restore can be undone. */
  prepareRestore: (documentId: string, versionId: string) =>
    api<Version>(`${base(documentId)}/${versionId}/restore`, { method: 'POST' }),
}

export function versionTitle(version: Version): string {
  if (version.kind === 'named' && version.label) return version.label
  if (version.kind === 'pre_merge') return `Before merging “${version.label ?? 'a branch'}”`
  if (version.kind === 'pre_restore') {
    const source = version.restored_from
    if (!source) return 'Before a restore'
    return `Before restoring ${source.label ? `“${source.label}”` : formatDateTime(source.created_at)}`
  }
  return 'Automatic version'
}
