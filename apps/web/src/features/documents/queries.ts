import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { uuid7 } from '../../lib/uuid7'
import type { User } from '../auth/session'
import { useAuth } from '../auth/useAuth'
import { sendOrQueue, whenOnServer } from '../offline/queue'
import { useOutbox } from '../offline/useOutbox'
import { documentsApi, type DashboardView, type DocumentSummary } from './api'

/** What the server names a document created without a title. */
export const UNTITLED = 'Untitled document'

const keys = {
  all: ['documents'] as const,
  lists: ['documents', 'list'] as const,
  list: (view: DashboardView) => ['documents', 'list', view] as const,
  one: (id: string) => ['documents', 'one', id] as const,
  search: (query: string) => ['documents', 'search', query] as const,
}

export function useDocuments(view: DashboardView) {
  return useQuery({ queryKey: keys.list(view), queryFn: () => documentsApi.list(view) })
}

export function useDocument(id: string) {
  const outbox = useOutbox()
  return useQuery({
    queryKey: keys.one(id),
    // Made on this device while offline: the server has never heard of it until it is sent.
    queryFn: async () => {
      await whenOnServer(outbox, id)
      return documentsApi.get(id)
    },
    retry: false,
  })
}

/** Full-text search. While the next query loads, the previous results stay on screen. */
export function useDocumentSearch(query: string) {
  return useQuery({
    queryKey: keys.search(query),
    queryFn: ({ signal }) => documentsApi.search(query, signal),
    enabled: query.length > 0,
    placeholderData: keepPreviousData,
  })
}

/** Changes one document wherever it is cached, so a change waiting in the outbox shows at once. */
function patchCached(
  queryClient: QueryClient,
  id: string,
  patch: (document: DocumentSummary) => DocumentSummary,
): void {
  queryClient.setQueryData<DocumentSummary>(keys.one(id), (old) => old && patch(old))
  queryClient.setQueriesData<DocumentSummary[]>({ queryKey: keys.lists }, (old) =>
    old?.map((document) => (document.id === id ? patch(document) : document)),
  )
}

/** A document made on this device, shaped as the server will describe it once it is sent. */
function localDocument(id: string, title: string, owner: User): DocumentSummary {
  const now = new Date().toISOString()
  return {
    id,
    title,
    role: 'owner',
    owner: { id: owner.id, name: owner.name },
    starred: false,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  }
}

/** Every change can move a document between lists, so all document queries are refetched. */
function useDocumentMutation<Args, Result>(fn: (args: Args) => Promise<Result>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.all }),
  })
}

/**
 * Creates a document under an id this browser chose (a UUIDv7), so it can be made offline too:
 * the outbox sends the same PUT later, and repeating it is harmless (ADR 0019).
 */
export function useCreateDocument() {
  const queryClient = useQueryClient()
  const outbox = useOutbox()
  const { user } = useAuth()
  return useMutation({
    mutationFn: async (title: string | undefined) => {
      const id = uuid7()
      const sent = await sendOrQueue(
        outbox,
        {
          kind: 'create',
          documentId: id,
          method: 'PUT',
          path: `/documents/${id}`,
          body: title ? { title } : undefined,
          label: `Create “${title ?? UNTITLED}”`,
        },
        () => documentsApi.createWithId(id, title),
      )
      return {
        document: sent.queued ? localDocument(id, title ?? UNTITLED, user!) : sent.result,
        queued: sent.queued,
      }
    },
    onSuccess: ({ document, queued }) => {
      queryClient.setQueryData(keys.one(document.id), document)
      if (!queued) return queryClient.invalidateQueries({ queryKey: keys.all })
      // Nothing to fetch yet: list it where the server will.
      for (const view of ['all', 'owned'] as const) {
        queryClient.setQueryData<DocumentSummary[]>(keys.list(view), (old) => [
          document,
          ...(old ?? []),
        ])
      }
    },
  })
}

export function useRenameDocument() {
  const queryClient = useQueryClient()
  const outbox = useOutbox()
  return useMutation({
    mutationFn: async ({ id, title }: { id: string; title: string }) => {
      patchCached(queryClient, id, (document) => ({ ...document, title }))
      return sendOrQueue(
        outbox,
        {
          kind: 'rename',
          documentId: id,
          method: 'PATCH',
          path: `/documents/${id}`,
          body: { title },
          supersedes: `rename:${id}`,
          label: `Rename to “${title}”`,
        },
        () => documentsApi.rename(id, title),
      )
    },
    // Queued: the cache already shows the new title, and fetching would bring the old one back.
    onSuccess: (sent) =>
      sent.queued ? undefined : queryClient.invalidateQueries({ queryKey: keys.all }),
    onError: () => queryClient.invalidateQueries({ queryKey: keys.all }),
  })
}

/** Stars are personal: each member stars documents for themselves. */
export function useStarDocument() {
  const queryClient = useQueryClient()
  const outbox = useOutbox()
  return useMutation({
    mutationFn: async ({ document, starred }: { document: DocumentSummary; starred: boolean }) => {
      const { id } = document
      patchCached(queryClient, id, (current) => ({ ...current, starred }))
      queryClient.setQueryData<DocumentSummary[]>(keys.list('starred'), (old) => {
        if (!old) return old
        const others = old.filter((d) => d.id !== id)
        return starred ? [{ ...document, starred }, ...others] : others
      })
      return sendOrQueue(
        outbox,
        {
          kind: 'star',
          documentId: id,
          method: starred ? 'PUT' : 'DELETE',
          path: `/documents/${id}/star`,
          supersedes: `star:${id}`,
          label: `${starred ? 'Star' : 'Unstar'} “${document.title}”`,
        },
        () => documentsApi.setStarred(id, starred),
      )
    },
    onSuccess: (sent) =>
      sent.queued ? undefined : queryClient.invalidateQueries({ queryKey: keys.all }),
    onError: () => queryClient.invalidateQueries({ queryKey: keys.all }),
  })
}

export const useTrashDocument = () => useDocumentMutation((id: string) => documentsApi.trash(id))

export const useRestoreDocument = () =>
  useDocumentMutation((id: string) => documentsApi.restore(id))
