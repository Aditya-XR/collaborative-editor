import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { Spinner } from '../../components/ui/Spinner'
import { describeError } from '../../lib/errors'
import { timeAgo } from '../../lib/time'
import type { Role } from '../documents/api'
import { branchesApi, type Branch } from './api'
import { useBranches, useBranchMutation } from './queries'
import { StatusBadge } from './StatusBadge'

/**
 * A document's branches: private copies people edit on their own and merge back after review.
 * Commenters may branch too, to propose changes they cannot make directly.
 */
export function BranchesDialog({
  documentId,
  role,
  onClose,
}: {
  documentId: string
  role: Role
  onClose: () => void
}) {
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const branches = useBranches(documentId)
  const canBranch = role !== 'viewer'

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    globalThis.addEventListener('keydown', onKey)
    panel.current?.querySelector<HTMLElement>('input, button')?.focus()
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-slate-950/40 p-4 pt-[8vh]"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-900"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id={titleId} className="text-lg font-semibold">
              Branches
            </h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Work on a copy without changing the document, then ask for review and merge it back.
            </p>
          </div>
          <Button variant="ghost" onClick={onClose} aria-label="Close branches">
            ✕
          </Button>
        </div>

        {canBranch && <NewBranchForm documentId={documentId} />}

        <section aria-label="Branch list" className="mt-5">
          {branches.isPending ? (
            <div className="flex justify-center py-8 text-indigo-600">
              <Spinner />
            </div>
          ) : branches.isError ? (
            <Alert>{describeError(branches.error)}</Alert>
          ) : branches.data.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
              No branches yet.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {branches.data.map((branch) => (
                <BranchRow key={branch.id} branch={branch} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}

function NewBranchForm({ documentId }: { documentId: string }) {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const create = useBranchMutation(documentId, (branchName: string) =>
    branchesApi.create(documentId, branchName),
  )

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const branchName = name.trim()
    if (!branchName) return
    await create.mutateAsync(branchName).then(
      (branch) => navigate(`/d/${documentId}/b/${branch.id}`),
      () => undefined,
    )
  }

  return (
    <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-2">
      <div className="flex gap-2">
        <input
          aria-label="New branch name"
          placeholder="Name a new branch, e.g. “Tighter intro”"
          value={name}
          maxLength={60}
          onChange={(event) => setName(event.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
        />
        <Button type="submit" busy={create.isPending} disabled={!name.trim()}>
          Create branch
        </Button>
      </div>
      {create.isError && <Alert>{describeError(create.error)}</Alert>}
    </form>
  )
}

function BranchRow({ branch }: { branch: Branch }) {
  const author = branch.created_by?.name ?? 'Someone'
  return (
    <li className="flex items-center gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <Link
          to={`/d/${branch.document_id}/b/${branch.id}`}
          className="block truncate text-sm font-medium hover:text-indigo-600 dark:hover:text-indigo-400"
        >
          {branch.name}
        </Link>
        <p className="truncate text-xs text-slate-500 dark:text-slate-400">
          {author} · updated {timeAgo(branch.updated_at)}
          {branch.status === 'open' && branch.review_requested_at && ' · review requested'}
        </p>
      </div>
      <StatusBadge status={branch.status} />
    </li>
  )
}
