import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { documentsApi, type DashboardView } from './api'

const keys = {
  all: ['documents'] as const,
  list: (view: DashboardView) => ['documents', 'list', view] as const,
  one: (id: string) => ['documents', 'one', id] as const,
  search: (query: string) => ['documents', 'search', query] as const,
}

export function useDocuments(view: DashboardView) {
  return useQuery({ queryKey: keys.list(view), queryFn: () => documentsApi.list(view) })
}

export function useDocument(id: string) {
  return useQuery({ queryKey: keys.one(id), queryFn: () => documentsApi.get(id), retry: false })
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

/** Every change can move a document between lists, so all document queries are refetched. */
function useDocumentMutation<Args, Result>(fn: (args: Args) => Promise<Result>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.all }),
  })
}

export const useCreateDocument = () =>
  useDocumentMutation((title: string | undefined) => documentsApi.create(title))

export const useRenameDocument = () =>
  useDocumentMutation(({ id, title }: { id: string; title: string }) =>
    documentsApi.rename(id, title),
  )

export const useTrashDocument = () => useDocumentMutation((id: string) => documentsApi.trash(id))

export const useRestoreDocument = () =>
  useDocumentMutation((id: string) => documentsApi.restore(id))
