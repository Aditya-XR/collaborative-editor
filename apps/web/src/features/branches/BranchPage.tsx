import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { Spinner } from '../../components/ui/Spinner'
import { describeError } from '../../lib/errors'
import { formatDateTime } from '../../lib/time'
import type { User } from '../auth/session'
import { useAuth } from '../auth/useAuth'
import type { DocumentSummary } from '../documents/api'
import { useDocument } from '../documents/queries'
import { CollaborativeEditor } from '../editor/CollaborativeEditor'
import { PresenceAvatars } from '../editor/PresenceAvatars'
import { SyncStatus } from '../editor/SyncStatus'
import { useCollab } from '../editor/useCollab'
import { AppHeader } from '../layout/AppHeader'
import { branchesApi, type Branch } from './api'
import { useBranch, useBranchMutation } from './queries'
import { StatusBadge } from './StatusBadge'

export function BranchPage() {
  const { documentId = '', branchId = '' } = useParams()
  const { user } = useAuth()
  const document = useDocument(documentId)
  const branch = useBranch(documentId, branchId)

  return (
    <div className="min-h-dvh bg-slate-50 dark:bg-slate-950">
      <AppHeader />
      <main className="mx-auto max-w-4xl px-4 py-6">
        <Link to={`/d/${documentId}`} className="text-sm text-indigo-600 dark:text-indigo-400">
          ← {document.data?.title ?? 'Document'}
        </Link>
        {document.isPending || branch.isPending ? (
          <div className="flex justify-center py-12 text-indigo-600">
            <Spinner />
          </div>
        ) : document.isError || branch.isError ? (
          <div className="mt-6">
            <Alert>{describeError(document.error ?? branch.error)}</Alert>
          </div>
        ) : (
          <LiveBranch
            key={branch.data.id}
            document={document.data}
            branch={branch.data}
            user={user!}
          />
        )}
      </main>
    </div>
  )
}

function LiveBranch({
  document,
  branch,
  user,
}: {
  document: DocumentSummary
  branch: Branch
  user: User
}) {
  const queryClient = useQueryClient()
  const { provider, state } = useCollab(document.id, user, branch.id)
  // The ticket's role is the live answer (it changes when the branch is merged or closed).
  const editable = branch.can_edit && (state.role === 'owner' || state.role === 'editor')

  // A merge or close elsewhere reconnects this editor with a read-only ticket; show why.
  useEffect(() => {
    if (state.role) void queryClient.invalidateQueries({ queryKey: ['branches', document.id] })
  }, [state.role, queryClient, document.id])

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{branch.name}</h1>
            <StatusBadge status={branch.status} />
          </div>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Branch of “{document.title}” by {branch.created_by?.name ?? 'someone'}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <PresenceAvatars peers={state.peers} />
          <SyncStatus state={state} />
        </div>
      </div>

      {branch.status === 'open' ? (
        <BranchActions document={document} branch={branch} />
      ) : (
        <p className="rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-700 dark:bg-slate-900 dark:text-slate-300">
          {branch.status === 'merged'
            ? `Merged into the document${branch.merged_by ? ` by ${branch.merged_by.name}` : ''} on ${formatDateTime(branch.merged_at!)}.`
            : `Closed on ${formatDateTime(branch.closed_at!)}; nothing from it reached the document.`}{' '}
          This branch is read-only.
        </p>
      )}

      {state.status === 'stopped' ? (
        <Alert>This branch is no longer available.</Alert>
      ) : state.localReady ? (
        <CollaborativeEditor provider={provider} user={user} editable={editable} />
      ) : (
        <div className="flex justify-center py-12 text-indigo-600">
          <Spinner />
        </div>
      )}
    </div>
  )
}

type Confirming = 'update' | 'close' | 'request' | null

function BranchActions({ document, branch }: { document: DocumentSummary; branch: Branch }) {
  const [confirming, setConfirming] = useState<Confirming>(null)
  const [description, setDescription] = useState(branch.description)
  const [updated, setUpdated] = useState(false)
  const update = useBranchMutation(document.id, () =>
    branchesApi.updateFromMain(document.id, branch.id),
  )
  const close = useBranchMutation(document.id, () => branchesApi.close(document.id, branch.id))
  const request = useBranchMutation(document.id, (wanted: boolean) =>
    branchesApi.update(document.id, branch.id, {
      review_requested: wanted,
      ...(wanted ? { description: description.trim() } : {}),
    }),
  )
  const error = update.error ?? close.error ?? request.error

  async function onRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await request.mutateAsync(true).then(
      () => setConfirming(null),
      () => undefined,
    )
  }

  return (
    <section aria-label="Branch actions" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to={`/d/${document.id}/b/${branch.id}/review`}
          className="inline-flex items-center rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-indigo-500"
        >
          {branch.can_merge ? 'Review and merge' : 'Review changes'}
        </Link>
        {branch.can_edit && (
          <>
            <Button variant="secondary" onClick={() => setConfirming('update')}>
              Update from main
            </Button>
            {branch.review_requested_at ? (
              <Button
                variant="ghost"
                busy={request.isPending}
                onClick={() => request.mutate(false)}
              >
                Withdraw review request
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => setConfirming('request')}>
                Request review
              </Button>
            )}
            <Button variant="danger" onClick={() => setConfirming('close')}>
              Close branch
            </Button>
          </>
        )}
        {branch.review_requested_at && (
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Review requested {formatDateTime(branch.review_requested_at)}
          </span>
        )}
      </div>
      {branch.description && !confirming && (
        <p className="text-sm whitespace-pre-line text-slate-600 dark:text-slate-300">
          {branch.description}
        </p>
      )}

      {confirming === 'update' && (
        <Confirm
          busy={update.isPending}
          action="Update"
          onCancel={() => setConfirming(null)}
          onConfirm={() =>
            update.mutateAsync(undefined).then(
              () => {
                setConfirming(null)
                setUpdated(true)
              },
              () => undefined,
            )
          }
        >
          Bring the document’s latest changes into this branch? Where both changed the same passage,
          both versions’ words end up here for you to fix; where the document deleted a passage this
          branch edited, the deletion wins. Review first to see those passages.
        </Confirm>
      )}
      {confirming === 'close' && (
        <Confirm
          busy={close.isPending}
          action="Close"
          onCancel={() => setConfirming(null)}
          onConfirm={() => close.mutate(undefined)}
        >
          Close this branch without merging? It stays readable, but nothing from it reaches the
          document.
        </Confirm>
      )}
      {confirming === 'request' && (
        <form
          onSubmit={onRequest}
          className="flex flex-col gap-2 rounded-lg bg-slate-100 p-3 dark:bg-slate-900"
        >
          <label htmlFor="branch-description" className="text-sm font-medium">
            What does this branch change, and why?
          </label>
          <textarea
            id="branch-description"
            value={description}
            maxLength={2000}
            rows={3}
            onChange={(event) => setDescription(event.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button type="submit" busy={request.isPending}>
              Request review
            </Button>
          </div>
        </form>
      )}
      {updated && !confirming && (
        <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">
          This branch now includes the document’s latest changes.
        </p>
      )}
      {error && <Alert>{describeError(error)}</Alert>}
    </section>
  )
}

function Confirm({
  children,
  action,
  busy,
  onCancel,
  onConfirm,
}: {
  children: string | string[]
  action: string
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
      <p className="min-w-0 flex-1">{children}</p>
      <Button variant="secondary" onClick={onCancel}>
        Cancel
      </Button>
      <Button busy={busy} onClick={onConfirm}>
        {action}
      </Button>
    </div>
  )
}
