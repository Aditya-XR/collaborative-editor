import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { branchesApi } from './api'

const keys = {
  all: (documentId: string) => ['branches', documentId] as const,
  list: (documentId: string) => ['branches', documentId, 'list'] as const,
  one: (documentId: string, branchId: string) => ['branches', documentId, branchId] as const,
  review: (documentId: string, branchId: string) =>
    ['branches', documentId, branchId, 'review'] as const,
}

export function useBranches(documentId: string) {
  return useQuery({
    queryKey: keys.list(documentId),
    queryFn: () => branchesApi.list(documentId),
  })
}

export function useBranch(documentId: string, branchId: string) {
  return useQuery({
    queryKey: keys.one(documentId, branchId),
    queryFn: () => branchesApi.get(documentId, branchId),
    retry: false,
  })
}

export function useReview(documentId: string, branchId: string) {
  return useQuery({
    queryKey: keys.review(documentId, branchId),
    queryFn: () => branchesApi.review(documentId, branchId),
    retry: false,
    // Main and the branch change while people edit: compare afresh whenever the page is visited.
    staleTime: 0,
  })
}

/** Any branch change can alter its status, the list, the review and main's version history. */
export function useBranchMutation<Args, Result>(
  documentId: string,
  fn: (args: Args) => Promise<Result>,
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.all(documentId) }),
        queryClient.invalidateQueries({ queryKey: ['versions', documentId] }),
      ]),
  })
}
