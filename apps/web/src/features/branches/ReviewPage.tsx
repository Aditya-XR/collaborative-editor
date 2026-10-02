import { useCallback, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { Spinner } from '../../components/ui/Spinner'
import { describeError } from '../../lib/errors'
import { AppHeader } from '../layout/AppHeader'
import { VersionPreview } from '../versions/VersionPreview'
import { branchesApi, type Change, type Review } from './api'
import { useBranchMutation, useReview } from './queries'
import { StatusBadge } from './StatusBadge'

/** What merging a branch would change in the document, and whether it can merge cleanly. */
export function ReviewPage() {
  const { documentId = '', branchId = '' } = useParams()
  const review = useReview(documentId, branchId)

  return (
    <div className="min-h-dvh bg-slate-50 dark:bg-slate-950">
      <AppHeader />
      <main className="mx-auto max-w-4xl px-4 py-6">
        <Link
          to={`/d/${documentId}/b/${branchId}`}
          className="text-sm text-indigo-600 dark:text-indigo-400"
        >
          ← Back to the branch
        </Link>
        {review.isPending ? (
          <div className="flex justify-center py-12 text-indigo-600">
            <Spinner />
          </div>
        ) : review.isError ? (
          <div className="mt-6">
            <Alert>{describeError(review.error)}</Alert>
          </div>
        ) : (
          <ReviewBody review={review.data} />
        )}
      </main>
    </div>
  )
}

function ReviewBody({ review }: { review: Review }) {
  const { branch, changes, conflicts } = review
  const onPreviewReady = useCallback(() => undefined, [])

  return (
    <div className="mt-4 flex flex-col gap-5">
      <header>
        <div className="flex items-center gap-2">
          <h1 className="truncate text-2xl font-semibold tracking-tight">Review “{branch.name}”</h1>
          <StatusBadge status={branch.status} />
        </div>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{summary(review)}</p>
        {branch.description && (
          <p className="mt-2 text-sm whitespace-pre-line text-slate-700 dark:text-slate-200">
            {branch.description}
          </p>
        )}
      </header>

      {branch.status === 'open' && <MergeBar review={review} />}

      <section aria-label="Changes" className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          {conflicts > 0 ? `Changes (${conflicts} in conflict)` : 'Changes'}
        </h2>
        {changes.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            This branch changes nothing in the document.
          </p>
        ) : (
          changes.map((change, index) => <ChangeCard key={index} change={change} />)
        )}
      </section>

      <section aria-label="Document after merging">
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          The document after merging
        </h2>
        <div className="mt-2 rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <VersionPreview state={review.preview} onReady={onPreviewReady} />
        </div>
      </section>
    </div>
  )
}

function summary({ changes, conflicts }: Review): string {
  const count = changes.length
  if (count === 0) return 'No changes yet.'
  const changed = `${count} ${count === 1 ? 'change' : 'changes'}`
  if (conflicts === 0) return `${changed}, none in conflict with the document.`
  return `${changed}; ${conflicts} ${conflicts === 1 ? 'passage was' : 'passages were'} also changed in the document since this branch started.`
}

function MergeBar({ review }: { review: Review }) {
  const navigate = useNavigate()
  const { branch } = review
  const [confirming, setConfirming] = useState(false)
  const merge = useBranchMutation(branch.document_id, () =>
    branchesApi.merge(branch.document_id, branch.id, review.head),
  )

  async function onMerge() {
    await merge.mutateAsync(undefined).then(
      () =>
        navigate(`/d/${branch.document_id}`, {
          state: { merged: branch.name },
        }),
      // The branch or the document may have moved on; the mutation reloads the review either
      // way, so the page shows it as it is now.
      () => setConfirming(false),
    )
  }

  if (!branch.can_merge) {
    return (
      <p className="rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-700 dark:bg-slate-900 dark:text-slate-300">
        {branch.review_requested_at
          ? 'Review requested. An owner or editor of the document can merge it.'
          : 'Only an owner or editor of the document can merge. Request review from the branch.'}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      {review.conflicts > 0 ? (
        <p className="rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          Can’t merge yet: the passages marked below were changed in the document too. Update the
          branch from main, settle them there, and review again.
        </p>
      ) : confirming ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-indigo-50 px-3 py-2 text-sm text-indigo-950 dark:bg-indigo-950 dark:text-indigo-100">
          <p className="min-w-0 flex-1">
            Merge these changes into the document for everyone? The document is saved in version
            history first, so restoring that version undoes the merge.
          </p>
          <Button variant="secondary" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button busy={merge.isPending} onClick={onMerge}>
            Merge
          </Button>
        </div>
      ) : (
        <div>
          <Button disabled={review.changes.length === 0} onClick={() => setConfirming(true)}>
            Merge into the document
          </Button>
        </div>
      )}
      {merge.isError && <Alert>{describeError(merge.error)}</Alert>}
    </div>
  )
}

const CHANGE_LABEL: Record<Change['kind'], string> = {
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
  conflict: 'Conflict',
}

function ChangeCard({ change }: { change: Change }) {
  const conflict = change.kind === 'conflict'
  return (
    <article
      aria-label={CHANGE_LABEL[change.kind]}
      className={`rounded-xl border p-3 text-sm ${
        conflict
          ? 'border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/40'
          : 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900'
      }`}
    >
      <p
        className={`text-xs font-semibold tracking-wide uppercase ${conflict ? 'text-amber-800 dark:text-amber-200' : 'text-slate-500 dark:text-slate-400'}`}
      >
        {CHANGE_LABEL[change.kind]}
      </p>
      <div className="mt-2 flex flex-col gap-2">
        {conflict ? (
          <>
            <Side label="The document now" blocks={change.main} empty="Deleted in the document" />
            <Side label="This branch" blocks={change.branch} empty="Deleted in this branch" />
          </>
        ) : (
          <>
            {/* An addition removes nothing, even where the document also added text: both stay. */}
            {change.kind !== 'added' && change.main.length > 0 && (
              <Side label="Before" blocks={change.main} tone="removed" />
            )}
            {change.branch.length > 0 && <Side label="After" blocks={change.branch} tone="added" />}
          </>
        )}
      </div>
    </article>
  )
}

function Side({
  label,
  blocks,
  tone,
  empty = '',
}: {
  label: string
  blocks: string[]
  tone?: 'added' | 'removed'
  empty?: string
}) {
  const toneClass =
    tone === 'added'
      ? 'border-l-emerald-500 bg-emerald-50/70 dark:bg-emerald-950/40'
      : tone === 'removed'
        ? 'border-l-rose-400 bg-rose-50/70 text-slate-600 line-through decoration-rose-400/60 dark:bg-rose-950/30 dark:text-slate-300'
        : 'border-l-slate-300 dark:border-l-slate-600'
  return (
    <div className={`rounded-md border-l-4 px-3 py-1.5 ${toneClass}`}>
      <p className="text-xs text-slate-500 no-underline dark:text-slate-400">{label}</p>
      {blocks.length === 0 ? (
        <p className="italic text-slate-500 dark:text-slate-400">{empty}</p>
      ) : (
        blocks.map((text, index) => (
          <p key={index} className="whitespace-pre-line">
            {text || '(empty line)'}
          </p>
        ))
      )}
    </div>
  )
}
