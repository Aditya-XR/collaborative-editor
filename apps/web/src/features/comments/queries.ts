import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import type { CollabProvider } from '../editor/CollabProvider'
import { commentsApi } from './api'

const keys = {
  threads: (documentId: string, branchId: string | null) =>
    ['comments', documentId, branchId ?? 'main'] as const,
}

/**
 * The comment threads of a document's main text or of one branch, kept fresh by the live
 * connection: the server signals every change, and a (re)connect refetches what may have been
 * missed while offline.
 */
export function useThreads(
  documentId: string,
  branchId: string | null,
  provider: CollabProvider,
  synced: boolean,
) {
  const queryClient = useQueryClient()
  const queryKey = keys.threads(documentId, branchId)

  useEffect(
    () =>
      provider.onCommentsChanged(() => {
        void queryClient.invalidateQueries({ queryKey: keys.threads(documentId, branchId) })
      }),
    [provider, queryClient, documentId, branchId],
  )

  useEffect(() => {
    if (synced) void queryClient.invalidateQueries({ queryKey: keys.threads(documentId, branchId) })
  }, [synced, queryClient, documentId, branchId])

  return useQuery({
    queryKey,
    queryFn: () => commentsApi.list(documentId, branchId),
  })
}

/** Every comment change refreshes the stream's threads; the server tells everyone else. */
export function useCommentMutation<Args, Result>(
  documentId: string,
  branchId: string | null,
  fn: (args: Args) => Promise<Result>,
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: keys.threads(documentId, branchId) }),
  })
}
