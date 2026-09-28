import { useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { Button } from '../../components/ui/Button'
import { timeAgo } from '../../lib/time'
import type { DocumentSummary } from './api'
import { useRenameDocument, useRestoreDocument, useTrashDocument } from './queries'

const ROLE_LABEL = {
  owner: 'Owner',
  editor: 'Can edit',
  commenter: 'Can comment',
  viewer: 'Can view',
}

export function DocumentRow({
  document,
  currentUserId,
}: {
  document: DocumentSummary
  currentUserId: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(document.title)
  // Escape unmounts the input, and some browsers fire blur on removal: don't save then.
  const cancelled = useRef(false)
  const rename = useRenameDocument()
  const trash = useTrashDocument()
  const restore = useRestoreDocument()

  const inTrash = document.deleted_at !== null
  const isOwner = document.role === 'owner'
  const canRename = !inTrash && (isOwner || document.role === 'editor')
  const owner = document.owner.id === currentUserId ? 'You' : document.owner.name

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
    <li className="flex items-center gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
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
            className="block truncate font-medium hover:text-indigo-600 dark:hover:text-indigo-400"
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
        </p>
      </div>
      <div className="flex shrink-0 gap-1">
        {canRename && !editing && (
          <Button variant="ghost" onClick={startEditing} aria-label={`Rename ${document.title}`}>
            Rename
          </Button>
        )}
        {isOwner && !inTrash && (
          <Button
            variant="danger"
            busy={trash.isPending}
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
