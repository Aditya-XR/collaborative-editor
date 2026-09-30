import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { FullPageSpinner } from '../../components/ui/Spinner'
import { ApiError } from '../../lib/api'
import { describeError } from '../../lib/errors'
import { sharingApi } from './api'

function explain(error: unknown): string {
  if (error instanceof ApiError && error.code === 'link_expired') {
    return 'This link has expired or was turned off. Ask the person who shared it for a new one.'
  }
  if (error instanceof ApiError && error.code === 'link_not_found') {
    return 'This link is not valid. Check that you copied all of it.'
  }
  return describeError(error)
}

/** /share/:token — signed-in visitors are added to the document, then taken to it. */
export function AcceptLinkPage() {
  const { token = '' } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const accept = useMutation({ mutationFn: () => sharingApi.accept(token) })
  const started = useRef(false)

  useEffect(() => {
    // Once, even under React's development double-mount (accepting is idempotent anyway).
    if (started.current) return
    started.current = true
    accept.mutateAsync().then(
      async ({ document_id }) => {
        await queryClient.invalidateQueries({ queryKey: ['documents'] })
        navigate(`/d/${document_id}`, { replace: true })
      },
      () => undefined,
    )
  }, [accept, navigate, queryClient])

  if (!accept.isError) return <FullPageSpinner label="Opening shared document" />
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-xl font-semibold">Can’t open this link</h1>
      <p role="alert" className="text-slate-600 dark:text-slate-300">
        {explain(accept.error)}
      </p>
      <Link to="/" className="font-medium text-indigo-600 dark:text-indigo-400">
        Go to your documents
      </Link>
    </main>
  )
}
