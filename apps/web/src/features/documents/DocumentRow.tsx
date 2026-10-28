import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import { Button } from '../../components/ui/Button'
import { hasOfflineCopy } from '../../lib/offline'
import { timeAgo } from '../../lib/time'
import { usePinnedDocuments } from '../offline/usePins'
import type { DocumentSummary } from './api'
import { useRenameDocument, useRestoreDocument, useStarDocument, useTrashDocument } from './queries'

const ROLE_LABEL = {
  owner: 'Owner',
  editor: 'Can edit',
  commenter: 'Can comment',
  viewer: 'Can view',
}

const NEEDS_CONNECTION = 'Needs a connection'

export function DocumentRow({
  document,
  currentUserId,
  online,
  notSent,
}: {
  document: DocumentSummary
  currentUserId: string
  /** The API can be reached; trashing and restoring need it. */
  online: boolean
  /** Created on this device and not on the server yet. */
  notSent: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(document.title)
  // Escape unmounts the input, and some browsers fire blur on removal: don't save then.
  const cancelled = useRef(false)
  const rename = useRenameDocument()
  const star = useStarDocument()
  const trash = useTrashDocument()
  const restore = useRestoreDocument()
  const { pinned, setPinned } = usePinnedDocuments(currentUserId)

  const inTrash = document.deleted_at !== null
  const isOwner = document.role === 'owner'
  const canRename = !inTrash && (isOwner || document.role === 'editor')
  const owner = document.owner.id === currentUserId ? 'You' : document.owner.name
  const kept = pinned.includes(document.id)
  // Offline, only documents this device holds a copy of can open.
  const unavailable = !online && !inTrash && !notSent && !hasOfflineCopy(currentUserId, document.id)

  function startEditing() {
    cancelled.current = false
    setDraft(document.title)
    setEditing(true)
  }

  function save() {
    if (cancelled.current) return
    const title = draft.trim()
    if (title && title !== document.title) rename.mutate({ id: document.id, title })
    else setDraft(document.title)
    setEditing(false)
  }

  function onRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    save()
  }

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      {!inTrash && (
        <IconToggle
          pressed={document.starred}
          label={`${document.starred ? 'Unstar' : 'Star'} ${document.title}`}
          onClick={() => star.mutate({ document, starred: !document.starred })}
          pressedClass="text-amber-500"
        >
          <StarIcon filled={document.starred} />
        </IconToggle>
      )}
      <div className="min-w-0 flex-1 basis-48">
        {editing ? (
          <form onSubmit={onRename}>
            <input
              aria-label="Document title"
              autoFocus
              maxLength={200}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={save}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  cancelled.current = true
                  setDraft(document.title)
                  setEditing(false)
                }
              }}
              className="w-full rounded-md border border-indigo-400 bg-white px-2 py-1 text-sm outline-none ring-2 ring-indigo-500/30 dark:bg-slate-900"
            />
          </form>
        ) : inTrash ? (
          <p className="truncate font-medium text-slate-500">{document.title}</p>
        ) : (
          <Link
            to={`/d/${document.id}`}
            className={`block truncate font-medium hover:text-indigo-600 dark:hover:text-indigo-400 ${unavailable ? 'text-slate-400 dark:text-slate-500' : ''}`}
          >
            {document.title}
          </Link>
        )}
        <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
          {owner} ·{' '}
          {inTrash
            ? `Trashed ${timeAgo(document.deleted_at!)}`
            : `Edited ${timeAgo(document.updated_at)}`}
          {!isOwner && ` · ${ROLE_LABEL[document.role]}`}
          {notSent && (
            <span className="text-amber-700 dark:text-amber-300"> · Not on the server yet</span>
          )}
          {unavailable && ' · Not available offline'}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {!inTrash && (
          <IconToggle
            pressed={kept}
            label={`Make ${document.title} available offline`}
            onClick={() => setPinned(document.id, !kept)}
            pressedClass="text-indigo-600 dark:text-indigo-400"
          >
            <OfflineIcon />
          </IconToggle>
        )}
        {canRename && !editing && (
          <Button variant="ghost" onClick={startEditing} aria-label={`Rename ${document.title}`}>
            Rename
          </Button>
        )}
        {isOwner && !inTrash && (
          <Button
            variant="danger"
            busy={trash.isPending}
            disabled={!online || notSent}
            title={online ? undefined : NEEDS_CONNECTION}
            onClick={() => trash.mutate(document.id)}
            aria-label={`Move ${document.title} to trash`}
          >
            Delete
          </Button>
        )}
        {inTrash && (
          <Button
            variant="secondary"
            busy={restore.isPending}
            disabled={!online}
            title={online ? undefined : NEEDS_CONNECTION}
            onClick={() => restore.mutate(document.id)}
            aria-label={`Restore ${document.title}`}
          >
            Restore
          </Button>
        )}
      </div>
    </li>
  )
}

function IconToggle({
  pressed,
  label,
  onClick,
  children,
  pressedClass,
}: {
  pressed: boolean
  label: string
  onClick: () => void
  children: ReactNode
  /** The color while pressed. */
  pressedClass: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={onClick}
      className={`rounded-lg p-1.5 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-indigo-500 dark:hover:bg-slate-800 ${pressed ? pressedClass : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'}`}
    >
      {children}
    </button>
  )
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 20 20" className="size-5" aria-hidden="true">
      <path
        d="M10 2.5l2.3 4.7 5.2.8-3.8 3.6.9 5.2L10 14.3l-4.6 2.5.9-5.2-3.8-3.6 5.2-.8z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** A cloud with an arrow down: kept on this device. */
function OfflineIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      className="size-5"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 15H5a3.5 3.5 0 0 1-.4-7A5 5 0 0 1 14.3 7 3.5 3.5 0 0 1 15 15h-1" />
      <path d="M10 9v7m-2.5-2.5L10 16l2.5-2.5" />
    </svg>
  )
}
