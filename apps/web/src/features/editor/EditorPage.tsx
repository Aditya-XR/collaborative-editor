import type { Content, Editor } from '@tiptap/react'
import { useCallback, useState, type KeyboardEvent } from 'react'
import { Button } from '../../components/ui/Button'
import { Link, useLocation, useParams } from 'react-router'
import { Alert } from '../../components/ui/Alert'
import { Spinner } from '../../components/ui/Spinner'
import { describeError } from '../../lib/errors'
import type { User } from '../auth/session'
import { useAuth } from '../auth/useAuth'
import type { DocumentSummary } from '../documents/api'
import { useDocument, useRenameDocument } from '../documents/queries'
import { AppHeader } from '../layout/AppHeader'
import { BranchesDialog } from '../branches/BranchesDialog'
import { CommentsPanel } from '../comments/CommentsPanel'
import { useComments } from '../comments/useComments'
import { ShareDialog } from '../sharing/ShareDialog'
import { versionTitle, type Version } from '../versions/api'
import { VersionHistory } from '../versions/VersionHistory'
import { CollaborativeEditor } from './CollaborativeEditor'
import type { StopReason } from './CollabProvider'
import { PresenceAvatars } from './PresenceAvatars'
import { SyncStatus } from './SyncStatus'
import { useCollab } from './useCollab'

export function EditorPage() {
  const { documentId = '' } = useParams()
  const { user } = useAuth()
  const document = useDocument(documentId)

  return (
    <div className="min-h-dvh bg-slate-50 dark:bg-slate-950">
      <AppHeader />
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Link to="/" className="text-sm text-indigo-600 dark:text-indigo-400">
          ← All documents
        </Link>
        {document.isPending ? (
          <CenteredSpinner />
        ) : document.isError ? (
          <div className="mt-6">
            <Alert>{describeError(document.error)}</Alert>
          </div>
        ) : (
          // Keyed so moving between documents builds a fresh editor and connection.
          <LiveDocument key={document.data.id} document={document.data} user={user!} />
        )}
      </main>
    </div>
  )
}

function LiveDocument({ document, user }: { document: DocumentSummary; user: User }) {
  const { provider, state } = useCollab(document.id, user)
  // The ticket carries the role as of now; the REST copy may be a few seconds older.
  const role = state.role ?? document.role
  const canEdit = role === 'owner' || role === 'editor'
  const [sharing, setSharing] = useState(false)
  const [history, setHistory] = useState(false)
  const [branching, setBranching] = useState(false)
  const closeBranches = useCallback(() => setBranching(false), [])
  // Set by the review page after a merge, to say what just happened.
  const merged = (useLocation().state as { merged?: string } | null)?.merged
  // State, not a ref: the comments panel works with the live editor once it exists.
  const [editor, setEditor] = useState<Editor | null>(null)
  const [restored, setRestored] = useState<string | null>(null)
  const closeHistory = useCallback(() => setHistory(false), [])
  const comments = useComments({
    documentId: document.id,
    branchId: null,
    provider,
    synced: state.synced,
    editor,
    canComment: role !== 'viewer',
  })

  // A restore is an ordinary edit through the live editor (ADR 0014): it reaches everyone like
  // typing, merges with their concurrent edits, and Undo reverts it.
  function restoreVersion(content: Content, version: Version) {
    editor?.commands.setContent(content)
    setHistory(false)
    setRestored(versionTitle(version))
  }

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <TitleField document={document} editable={canEdit} />
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Owned by {document.owner.id === user.id ? 'you' : document.owner.name}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <PresenceAvatars peers={state.peers} />
          <SyncStatus state={state} />
          {state.status !== 'stopped' && (
            <Button variant="secondary" onClick={() => setBranching(true)}>
              Branches
            </Button>
          )}
          {state.status !== 'stopped' && canEdit && (
            <Button variant="secondary" onClick={() => setHistory(true)}>
              History
            </Button>
          )}
          {state.status !== 'stopped' && <Button onClick={() => setSharing(true)}>Share</Button>}
        </div>
      </div>

      {state.status === 'stopped' ? (
        <StopNotice reason={state.stopReason} />
      ) : (
        <>
          {!canEdit && (
            <p className="rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
              You have {role === 'commenter' ? 'comment' : 'view'} access. Changes by others appear
              live.
            </p>
          )}
          {merged && !restored && (
            <p
              role="status"
              className="rounded-lg bg-violet-50 px-4 py-2 text-sm text-violet-900 dark:bg-violet-950 dark:text-violet-100"
            >
              Merged “{merged}” into this document. The text from before is saved in version
              history.
            </p>
          )}
          {restored && (
            <p
              role="status"
              className="flex items-center gap-3 rounded-lg bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100"
            >
              <span className="flex-1">
                Restored {restored}. The text from before is saved in version history, and Undo
                reverts it.
              </span>
              <Button variant="ghost" onClick={() => setRestored(null)} aria-label="Dismiss">
                ✕
              </Button>
            </p>
          )}
          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
            {state.localReady ? (
              <CollaborativeEditor
                provider={provider}
                user={user}
                editable={canEdit}
                onReady={setEditor}
                comments={comments.editorHandlers}
              />
            ) : (
              <CenteredSpinner />
            )}
            <CommentsPanel controller={comments} />
          </div>
        </>
      )}
      {branching && <BranchesDialog documentId={document.id} role={role} onClose={closeBranches} />}
      {history && (
        <VersionHistory
          documentId={document.id}
          onRestore={restoreVersion}
          onClose={closeHistory}
        />
      )}
      {sharing && (
        <ShareDialog
          document={document}
          currentUser={user}
          role={role}
          onClose={() => setSharing(false)}
        />
      )}
    </div>
  )
}

function TitleField({ document, editable }: { document: DocumentSummary; editable: boolean }) {
  const rename = useRenameDocument()
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? document.title

  function save() {
    const title = value.trim()
    if (title && title !== document.title) rename.mutate({ id: document.id, title })
    setDraft(null)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') event.currentTarget.blur()
    if (event.key === 'Escape') {
      setDraft(null)
      requestAnimationFrame(() => event.currentTarget?.blur())
    }
  }

  if (!editable) {
    return <h1 className="truncate text-2xl font-semibold tracking-tight">{document.title}</h1>
  }
  return (
    <>
      <h1 className="sr-only">{document.title}</h1>
      <input
        aria-label="Document title"
        value={value}
        maxLength={200}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={save}
        onKeyDown={onKeyDown}
        className="w-full truncate rounded-md bg-transparent px-1 py-0.5 text-2xl font-semibold tracking-tight outline-none hover:bg-slate-100 focus:bg-white focus:ring-2 focus:ring-indigo-500/40 dark:hover:bg-slate-900 dark:focus:bg-slate-900"
      />
    </>
  )
}

const STOP_MESSAGES: Record<StopReason, string> = {
  // A removal looks the same as a deletion from here: the ticket request answers 404 either way.
  not_found: 'This document was deleted, or your access to it was removed.',
  forbidden: 'Your access to this document was removed. Its copy on this device was deleted.',
  signed_out: 'Your session ended. Sign in again to keep editing.',
  rejected: 'The server could not accept this document’s changes. Reload the page to try again.',
}

function StopNotice({ reason }: { reason: StopReason | null }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center dark:border-slate-800 dark:bg-slate-900">
      <Alert>{STOP_MESSAGES[reason ?? 'rejected']}</Alert>
      <Link
        to={reason === 'signed_out' ? '/login' : '/'}
        className="mt-4 inline-block text-sm font-medium text-indigo-600 dark:text-indigo-400"
      >
        {reason === 'signed_out' ? 'Sign in' : 'Back to your documents'}
      </Link>
    </div>
  )
}

function CenteredSpinner() {
  return (
    <div className="flex justify-center py-12 text-indigo-600">
      <Spinner />
    </div>
  )
}
