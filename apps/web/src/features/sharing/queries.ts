import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { sharingApi } from './api'

const keys = {
  members: (documentId: string) => ['sharing', documentId, 'members'] as const,
  links: (documentId: string) => ['sharing', documentId, 'links'] as const,
}

export function useMembers(documentId: string) {
  return useQuery({
    queryKey: keys.members(documentId),
    queryFn: () => sharingApi.members(documentId),
  })
}

export function useLinks(documentId: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.links(documentId),
    queryFn: () => sharingApi.links(documentId),
    enabled,
  })
}

/** Sharing changes can alter anyone's role, the owner and the documents list, so refetch all. */
export function useSharingMutation<Args, Result>(
  documentId: string,
  fn: (args: Args) => Promise<Result>,
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['sharing', documentId] }),
        queryClient.invalidateQueries({ queryKey: ['documents'] }),
      ])
    },
  })
}
