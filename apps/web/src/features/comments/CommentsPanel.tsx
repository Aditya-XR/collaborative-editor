import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { Spinner } from '../../components/ui/Spinner'
import { describeError } from '../../lib/errors'
import { isUnreachable } from '../../lib/network'
import { timeAgo } from '../../lib/time'
import { uuid7 } from '../../lib/uuid7'
import { sendOrQueue } from '../offline/queue'
import { useOutbox } from '../offline/useOutbox'
import { commentsApi, replyPath, threadBody, threadsPath, type Comment, type Thread } from './api'
import { pendingThreadId } from './pending'
import { useCommentMutation } from './queries'
import type { CommentsController, Filter } from './useComments'

const BODY_MAX = 4000

/** "Comment “Looks good to me…”": how a queued comment is named if the server refuses it. */
function labelFor(action: string, text: string): string {
  return `${action} “${text.length > 40 ? `${text.slice(0, 40)}…` : text}”`
}

/** The comment threads of the open document or branch, beside its text. */
export function CommentsPanel({ controller }: { controller: CommentsController }) {
  const titleId = useId()
  const { threads, visible, counts, filter, draft, canComment, hint } = controller

  return (
    <aside
      aria-labelledby={titleId}
      className="flex flex-col gap-3 lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id={titleId} className="text-sm font-semibold">
          Comments
        </h2>
        {canComment && (
          <Button
            variant="secondary"
            onClick={controller.startComment}
            title="Select text first (Ctrl+Alt+M)"
          >
            Add comment
          </Button>
        )}
      </div>
      {hint && !draft && <p className="text-xs text-amber-700 dark:text-amber-300">{hint}</p>}

      {draft && <NewThreadForm controller={controller} />}

      <div role="group" aria-label="Show" className="flex gap-1">
        {(['open', 'resolved'] as Filter[]).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={filter === option}
            onClick={() => controller.setFilter(option)}
            className="rounded-full px-3 py-1 text-xs font-medium text-slate-600 aria-pressed:bg-slate-200 aria-pressed:text-slate-900 dark:text-slate-300 dark:aria-pressed:bg-slate-800 dark:aria-pressed:text-white"
          >
            {option === 'open' ? 'Open' : 'Resolved'} ({counts[option]})
          </button>
        ))}
      </div>

      {threads.data === undefined && controller.all.length === 0 ? (
        threads.fetchStatus === 'paused' || isUnreachable(threads.error) ? (
          <p className="py-4 text-center text-sm text-slate-500 dark:text-slate-400">
            Comments load when you’re back online.
          </p>
        ) : threads.isError ? (
          <Alert>{describeError(threads.error)}</Alert>
        ) : (
          <div className="flex justify-center py-6 text-indigo-600">
            <Spinner />
          </div>
        )
      ) : visible.length === 0 ? (
        <p className="py-4 text-center text-sm text-slate-500 dark:text-slate-400">
          {filter === 'open'
            ? canComment
              ? 'No comments yet. Select some text and choose Add comment.'
              : 'No comments yet.'
            : 'No resolved comments.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {visible.map((thread) => (
            <li key={thread.id}>
              <ThreadCard
                thread={thread}
                controller={controller}
                detached={!thread.resolved_at && controller.ranges[thread.id] === null}
              />
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}

function NewThreadForm({ controller }: { controller: CommentsController }) {
  const { documentId, branchId, draft } = controller
  const [body, setBody] = useState('')
  const outbox = useOutbox()
  // Sent now, or queued while offline; either way the browser names it, so a retry lands once.
  const create = useCommentMutation(documentId, branchId, async (text: string) => {
    const thread = {
      client_id: uuid7(),
      anchor_start: draft!.start,
      anchor_end: draft!.end,
      quoted_text: draft!.quote,
      body: text,
    }
    const sent = await sendOrQueue(
      outbox,
      {
        kind: 'thread',
        documentId,
        method: 'POST',
        path: threadsPath(documentId),
        body: threadBody(branchId, thread),
        label: labelFor('Comment', text),
      },
      () => commentsApi.create(documentId, branchId, thread),
    )
    return sent.queued ? pendingThreadId(thread.client_id) : sent.result.id
  })

  async function submit(event: FormEvent) {
    event.preventDefault()
    const text = body.trim()
    if (!text) return
    await create.mutateAsync(text).then(
      (threadId) => {
        controller.cancelDraft()
        controller.select(threadId)
      },
      () => undefined,
    )
  }

  return (
    <form
      onSubmit={submit}
      aria-label="New comment"
      className="flex flex-col gap-2 rounded-xl border border-amber-300 bg-white p-3 shadow-sm dark:border-amber-700 dark:bg-slate-900"
    >
      <Quote text={draft!.quote} />
      <TextArea
        label="Comment"
        value={body}
        onChange={setBody}
        onSubmit={submit}
        onCancel={controller.cancelDraft}
        autoFocus
      />
      {create.error && <Alert>{describeError(create.error)}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={controller.cancelDraft}>
          Cancel
        </Button>
        <Button type="submit" busy={create.isPending} disabled={!body.trim()}>
          Comment
        </Button>
      </div>
    </form>
  )
}

function ThreadCard({
  thread,
  controller,
  detached,
}: {
  thread: Thread
  controller: CommentsController
  /** Open, but every character it was about has been deleted. */
  detached: boolean
}) {
  const { documentId, branchId } = controller
  const active = controller.active === thread.id
  const card = useRef<HTMLElement>(null)
  const [reply, setReply] = useState('')
  const resolve = useCommentMutation(documentId, branchId, (resolved: boolean) =>
    commentsApi.setResolved(documentId, thread.id, resolved),
  )
  const outbox = useOutbox()
  const answer = useCommentMutation(documentId, branchId, (text: string) => {
    const clientId = uuid7()
    return sendOrQueue(
      outbox,
      {
        kind: 'reply',
        documentId,
        threadId: thread.id,
        method: 'POST',
        path: replyPath(documentId, thread.id),
        body: { body: text, client_id: clientId },
        label: labelFor('Reply', text),
      },
      () => commentsApi.reply(documentId, thread.id, text, clientId),
    )
  })
  const error = resolve.error ?? answer.error

  // A click on the passage selects the thread: bring its card into view.
  useEffect(() => {
    if (active) card.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }, [active])

  async function submitReply(event: FormEvent) {
    event.preventDefault()
    const text = reply.trim()
    if (!text) return
    await answer.mutateAsync(text).then(
      () => setReply(''),
      () => undefined,
    )
  }

  return (
    <article
      ref={card}
      aria-label={`Comment on “${thread.quoted_text || 'the document'}”`}
      aria-current={active || undefined}
      onClick={() => !active && controller.select(thread.id, true)}
      className={`flex cursor-default flex-col gap-2 rounded-xl border bg-white p-3 text-sm dark:bg-slate-900 ${
        active
          ? 'border-amber-400 shadow-md dark:border-amber-600'
          : 'border-slate-200 hover:border-slate-300 dark:border-slate-800 dark:hover:border-slate-700'
      }`}
    >
      {/* The card takes clicks anywhere; this button makes selecting it work from the keyboard. */}
      <button
        type="button"
        aria-label="Show in document"
        aria-expanded={active}
        onClick={(event) => {
          event.stopPropagation()
          controller.select(thread.id, true)
        }}
        className="rounded text-left focus-visible:outline-2 focus-visible:outline-indigo-500"
      >
        {thread.quoted_text ? (
          <Quote text={thread.quoted_text} />
        ) : (
          <span className="text-xs text-slate-500">Show in document</span>
        )}
      </button>
      {detached && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          The text this was about was deleted.
        </p>
      )}
      {thread.pending && (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          Not sent yet: it goes out when you’re back online. Replies can follow then.
        </p>
      )}
      <ol className="flex flex-col gap-3">
        {thread.comments.map((comment, index) => (
          <li key={comment.id}>
            <CommentItem
              comment={comment}
              first={index === 0}
              documentId={documentId}
              branchId={branchId}
            />
          </li>
        ))}
      </ol>
      {thread.resolved_at && (
        <p className="text-xs text-emerald-700 dark:text-emerald-300">
          Resolved{thread.resolved_by ? ` by ${thread.resolved_by.name}` : ''}{' '}
          {timeAgo(thread.resolved_at)}
        </p>
      )}
      {error && <Alert>{describeError(error)}</Alert>}
      {thread.can_reply && active && (
        <form onSubmit={submitReply} className="flex flex-col gap-2" aria-label="Reply">
          <TextArea label="Reply" value={reply} onChange={setReply} onSubmit={submitReply} />
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              busy={resolve.isPending}
              onClick={() => resolve.mutate(!thread.resolved_at)}
            >
              {thread.resolved_at ? 'Reopen' : 'Resolve'}
            </Button>
            <Button type="submit" busy={answer.isPending} disabled={!reply.trim()}>
              Reply
            </Button>
          </div>
        </form>
      )}
    </article>
  )
}

function CommentItem({
  comment,
  first,
  documentId,
  branchId,
}: {
  comment: Comment
  first: boolean
  documentId: string
  branchId: string | null
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const edit = useCommentMutation(documentId, branchId, (text: string) =>
    commentsApi.edit(documentId, comment.id, text),
  )
  const remove = useCommentMutation(documentId, branchId, () =>
    commentsApi.remove(documentId, comment.id),
  )
  const error = edit.error ?? remove.error

  async function save(event: FormEvent) {
    event.preventDefault()
    const text = editing?.trim()
    if (!text) return
    await edit.mutateAsync(text).then(
      () => setEditing(null),
      () => undefined,
    )
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <p className="min-w-0 truncate">
          <span className="font-medium">{comment.author?.name ?? 'Deleted account'}</span>{' '}
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {comment.pending ? 'Not sent yet' : timeAgo(comment.created_at)}
            {comment.edited_at && ' (edited)'}
          </span>
        </p>
        {editing === null && !confirming && (comment.can_edit || comment.can_delete) && (
          <span className="flex shrink-0 gap-1">
            {comment.can_edit && (
              <SmallButton onClick={() => setEditing(comment.body)}>Edit</SmallButton>
            )}
            {comment.can_delete && (
              <SmallButton onClick={() => setConfirming(true)}>Delete</SmallButton>
            )}
          </span>
        )}
      </div>
      {editing !== null ? (
        <form onSubmit={save} className="flex flex-col gap-2" aria-label="Edit comment">
          <TextArea
            label="Edit comment"
            value={editing}
            onChange={setEditing}
            onSubmit={save}
            onCancel={() => setEditing(null)}
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button type="submit" busy={edit.isPending} disabled={!editing.trim()}>
              Save
            </Button>
          </div>
        </form>
      ) : (
        <p className="break-words whitespace-pre-wrap text-slate-700 dark:text-slate-200">
          {comment.body}
        </p>
      )}
      {confirming && (
        <div className="flex items-center gap-2 rounded-lg bg-rose-50 px-2 py-1.5 text-xs text-rose-800 dark:bg-rose-950 dark:text-rose-200">
          <span className="flex-1">
            {first ? 'Delete the whole thread?' : 'Delete this reply?'}
          </span>
          <SmallButton onClick={() => setConfirming(false)}>Cancel</SmallButton>
          <SmallButton onClick={() => remove.mutate(undefined)} danger>
            Delete
          </SmallButton>
        </div>
      )}
      {error && <Alert>{describeError(error)}</Alert>}
    </div>
  )
}

function Quote({ text }: { text: string }) {
  return (
    <blockquote className="line-clamp-3 border-l-4 border-amber-300 pl-2 text-xs text-slate-600 italic dark:border-amber-700 dark:text-slate-300">
      {text}
    </blockquote>
  )
}

function TextArea({
  label,
  value,
  onChange,
  onSubmit,
  onCancel,
  autoFocus,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  onSubmit: (event: FormEvent) => void
  onCancel?: () => void
  autoFocus?: boolean
}) {
  // Ctrl+Enter sends, Escape cancels: the shortcuts every comment box has.
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) onSubmit(event)
    if (event.key === 'Escape' && onCancel) onCancel()
  }
  return (
    <textarea
      aria-label={label}
      value={value}
      maxLength={BODY_MAX}
      rows={2}
      // oxlint-disable-next-line jsx-a11y/no-autofocus -- focus follows the user's own action
      autoFocus={autoFocus}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      onClick={(event) => event.stopPropagation()}
      className="w-full resize-y rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40 dark:border-slate-700 dark:bg-slate-950"
    />
  )
}

function SmallButton({
  children,
  onClick,
  danger = false,
}: {
  children: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className={`rounded px-1.5 py-0.5 text-xs font-medium ${
        danger
          ? 'text-rose-700 hover:bg-rose-100 dark:text-rose-300 dark:hover:bg-rose-900'
          : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100'
      }`}
    >
      {children}
    </button>
  )
}
