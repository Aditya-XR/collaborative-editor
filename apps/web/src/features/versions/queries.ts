import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { versionsApi } from './api'

const keys = {
  all: (documentId: string) => ['versions', documentId] as const,
  list: (documentId: string) => ['versions', documentId, 'list'] as const,
  one: (documentId: string, versionId: string) => ['versions', documentId, versionId] as const,
}

export function useVersions(documentId: string) {
  return useQuery({ queryKey: keys.list(documentId), queryFn: () => versionsApi.list(documentId) })
}

export function useVersion(documentId: string, versionId: string | null) {
  return useQuery({
    queryKey: keys.one(documentId, versionId ?? ''),
    queryFn: () => versionsApi.get(documentId, versionId!),
    enabled: versionId !== null,
    // A version's content never changes; only its name can.
    staleTime: Infinity,
  })
}

export function useVersionMutation<Args, Result>(
  documentId: string,
  fn: (args: Args) => Promise<Result>,
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.all(documentId) }),
  })
}
