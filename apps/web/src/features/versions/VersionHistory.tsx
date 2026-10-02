import type { Content, Editor } from '@tiptap/react'
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { Spinner } from '../../components/ui/Spinner'
import { describeError } from '../../lib/errors'
import { formatDateTime } from '../../lib/time'
import { versionsApi, versionTitle, type Version } from './api'
import { useVersion, useVersionMutation, useVersions } from './queries'
import { VersionPreview } from './VersionPreview'

const inputClass =
  'min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900'

/**
 * Lists a document's versions, previews one, and restores it.
 *
 * Restoring hands the version's content to `onRestore`, which sets it on the live editor: an
 * ordinary edit, so collaborators' concurrent changes still merge and Ctrl+Z undoes it
 * (ADR 0014). The server first saves the current text as a version, so even after the undo
 * history is gone the restore can be reversed.
 */
export function VersionHistory({
  documentId,
  onRestore,
  onClose,
}: {
  documentId: string
  onRestore: (content: Content, version: Version) => void
  onClose: () => void
}) {
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const versions = useVersions(documentId)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = versions.data?.find((version) => version.id === selectedId) ?? null

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    globalThis.addEventListener('keydown', onKey)
    panel.current?.querySelector<HTMLElement>('input, button')?.focus()
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-slate-950/40 p-4 pt-[6vh]"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-5xl rounded-2xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-900"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id={titleId} className="text-lg font-semibold">
            Version history
          </h2>
          <Button variant="ghost" onClick={onClose} aria-label="Close version history">
            ✕
          </Button>
        </div>
        <SaveVersionForm documentId={documentId} onSaved={setSelectedId} />

        <div className="mt-4 grid gap-4 md:grid-cols-[17rem_1fr]">
          <section aria-label="Versions" className="md:max-h-[60vh] md:overflow-y-auto">
            {versions.isPending ? (
              <div className="flex justify-center py-8 text-indigo-600">
                <Spinner />
              </div>
            ) : versions.isError ? (
              <Alert>{describeError(versions.error)}</Alert>
            ) : versions.data.length === 0 ? (
              <p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
                No versions yet. One is saved when everyone stops editing, and you can save one
                yourself above.
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {versions.data.map((version) => (
                  <li key={version.id}>
                    <button
                      type="button"
                      aria-current={version.id === selectedId ? 'true' : undefined}
                      onClick={() => setSelectedId(version.id)}
                      className="w-full rounded-lg px-3 py-2 text-left hover:bg-slate-100 aria-[current=true]:bg-indigo-50 aria-[current=true]:ring-1 aria-[current=true]:ring-indigo-300 dark:hover:bg-slate-800 dark:aria-[current=true]:bg-indigo-950 dark:aria-[current=true]:ring-indigo-700"
                    >
                      <span
                        className={`block truncate text-sm ${version.kind === 'named' ? 'font-semibold' : ''}`}
                      >
                        {versionTitle(version)}
                      </span>
                      <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                        {formatDateTime(version.created_at)}
                        {version.created_by && ` · ${version.created_by.name}`}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section
            aria-label="Selected version"
            className="min-h-64 rounded-xl border border-slate-200 dark:border-slate-800"
          >
            {selected ? (
              <SelectedVersion
                key={selected.id}
                documentId={documentId}
                version={selected}
                onRestore={onRestore}
              />
            ) : (
              <p className="px-6 py-16 text-center text-sm text-slate-500 dark:text-slate-400">
                Select a version to see the document as it was.
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

function SaveVersionForm({
  documentId,
  onSaved,
}: {
  documentId: string
  onSaved: (versionId: string) => void
}) {
  const [label, setLabel] = useState('')
  const save = useVersionMutation(documentId, (name: string) => versionsApi.save(documentId, name))

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = label.trim()
    if (!name) return
    await save.mutateAsync(name).then(
      (version) => {
        setLabel('')
        onSaved(version.id)
      },
      () => undefined,
    )
  }

  return (
    <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-2">
      <div className="flex gap-2">
        <input
          aria-label="Name for the current version"
          placeholder="Name the current version, e.g. “Sent for review”"
          value={label}
          maxLength={100}
          onChange={(event) => setLabel(event.target.value)}
          className={inputClass}
        />
        <Button type="submit" busy={save.isPending} disabled={!label.trim()}>
          Save version
        </Button>
      </div>
      {save.isError && <Alert>{describeError(save.error)}</Alert>}
    </form>
  )
}

function SelectedVersion({
  documentId,
  version,
  onRestore,
}: {
  documentId: string
  version: Version
  onRestore: (content: Content, version: Version) => void
}) {
  const detail = useVersion(documentId, version.id)
  const preview = useRef<Editor | null>(null)
  const [previewReady, setPreviewReady] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const restore = useVersionMutation(documentId, () =>
    versionsApi.prepareRestore(documentId, version.id),
  )
  const onPreviewReady = useCallback((editor: Editor | null) => {
    preview.current = editor
    setPreviewReady(editor !== null)
  }, [])

  async function onConfirmRestore() {
    const content = preview.current?.getJSON()
    if (!content) return
    await restore.mutateAsync(undefined).then(
      () => onRestore(content, version),
      () => undefined,
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{versionTitle(version)}</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {formatDateTime(version.created_at)}
            {version.created_by && ` · ${version.created_by.name}`}
          </p>
        </div>
        <NameControl documentId={documentId} version={version} />
        <Button variant="secondary" disabled={!previewReady} onClick={() => setConfirming(true)}>
          Restore this version
        </Button>
      </div>
      {confirming && (
        <div className="flex flex-wrap items-center gap-2 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <p className="flex-1">
            Replace the document with this version for everyone? The current text is saved as a
            version first.
          </p>
          <Button variant="secondary" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button busy={restore.isPending} onClick={onConfirmRestore}>
            Restore
          </Button>
        </div>
      )}
      {restore.isError && (
        <div className="px-4 pt-2">
          <Alert>{describeError(restore.error)}</Alert>
        </div>
      )}
      <div className="flex-1 overflow-y-auto md:max-h-[52vh]">
        {detail.isPending ? (
          <div className="flex justify-center py-12 text-indigo-600">
            <Spinner />
          </div>
        ) : detail.isError ? (
          <div className="p-4">
            <Alert>{describeError(detail.error)}</Alert>
          </div>
        ) : (
          <VersionPreview state={detail.data.state} onReady={onPreviewReady} />
        )}
      </div>
    </div>
  )
}

function NameControl({ documentId, version }: { documentId: string; version: Version }) {
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(version.label ?? '')
  const rename = useVersionMutation(documentId, (next: string | null) =>
    versionsApi.rename(documentId, version.id, next),
  )

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = label.trim()
    if (!name) return
    await rename.mutateAsync(name).then(
      () => setEditing(false),
      () => undefined,
    )
  }

  if (editing) {
    return (
      <form onSubmit={onSubmit} className="flex basis-full flex-col gap-2">
        <div className="flex gap-2">
          <input
            aria-label="Version name"
            autoFocus
            value={label}
            maxLength={100}
            onChange={(event) => setLabel(event.target.value)}
            className={inputClass}
          />
          <Button variant="secondary" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button type="submit" busy={rename.isPending} disabled={!label.trim()}>
            Save name
          </Button>
        </div>
        {rename.isError && <Alert>{describeError(rename.error)}</Alert>}
      </form>
    )
  }
  return (
    <>
      <Button variant="ghost" onClick={() => setEditing(true)}>
        {version.kind === 'named' ? 'Rename' : 'Name this version'}
      </Button>
      {version.kind === 'named' && (
        <Button variant="ghost" busy={rename.isPending} onClick={() => rename.mutate(null)}>
          Remove name
        </Button>
      )}
    </>
  )
}
