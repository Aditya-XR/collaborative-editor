import { useEditorState, type Editor } from '@tiptap/react'
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import type { CollabProvider } from '../editor/CollabProvider'
import { anchorSelection, type Anchor, type Range } from './anchors'
import type { Thread } from './api'
import { showThreads, threadRanges, type CommentHandlers } from './CommentHighlights'
import { useThreads } from './queries'

export type Filter = 'open' | 'resolved'

export interface CommentsController {
  documentId: string
  branchId: string | null
  threads: ReturnType<typeof useThreads>
  /** Open or resolved threads, open ones in the order their passages appear. */
  visible: Thread[]
  counts: Record<Filter, number>
  filter: Filter
  setFilter: (filter: Filter) => void
  /** Where each thread's passage is now; null when its text was deleted. */
  ranges: Record<string, Range | null>
  active: string | null
  select: (threadId: string | null, reveal?: boolean) => void
  /** The passage a new thread is being written about. */
  draft: Anchor | null
  cancelDraft: () => void
  startComment: () => void
  /** Why "Add comment" did nothing, until the next try. */
  hint: string | null
  canComment: boolean
  /** For the editor: what a click on a highlight does. */
  editorHandlers: CommentHandlers
}

const NO_RANGES: Record<string, Range | null> = {}

/** Scrolls the editor to a passage, without moving anyone's cursor. */
function revealPassage(editor: Editor, range: Range) {
  const { node } = editor.view.domAtPos(range.from)
  const element = node instanceof Element ? node : node.parentElement
  element?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
}

/**
 * Comment state for one live editor: the threads, which one is selected, the highlights in the
 * text, and a new thread being written. Shared by the document and branch pages.
 */
export function useComments({
  documentId,
  branchId,
  provider,
  synced,
  editor,
  canComment,
}: {
  documentId: string
  branchId: string | null
  provider: CollabProvider
  synced: boolean
  editor: Editor | null
  canComment: boolean
}): CommentsController {
  const threads = useThreads(documentId, branchId, provider, synced)
  const [searchParams] = useSearchParams()
  // A thread named in the address (a notification email's link) starts selected and in view.
  const [linkedId] = useState(() => searchParams.get('thread'))
  const revealLinked = useRef(linkedId !== null)
  const [active, setActive] = useState<string | null>(linkedId)
  const [chosenFilter, setFilter] = useState<Filter | null>(null)
  const [draft, setDraft] = useState<Anchor | null>(null)
  const [hint, setHint] = useState<string | null>(null)

  const ranges = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      current ? Object.fromEntries(threadRanges(current.state)) : NO_RANGES,
  })

  const all = useMemo(() => threads.data ?? [], [threads.data])
  const linked = linkedId ? all.find((t) => t.id === linkedId) : undefined
  // Until someone picks a list, show the one the linked thread is in.
  const filter = chosenFilter ?? (linked?.resolved_at ? 'resolved' : 'open')
  const counts = useMemo(
    () => ({
      open: all.filter((t) => !t.resolved_at).length,
      resolved: all.filter((t) => t.resolved_at).length,
    }),
    [all],
  )
  const visible = useMemo(() => {
    const wanted = all.filter((t) => (filter === 'open' ? !t.resolved_at : t.resolved_at))
    if (filter === 'resolved') return wanted.reverse() // most recently opened first
    // Open threads in reading order; those whose text was deleted go last.
    const at = (t: Thread) => ranges?.[t.id]?.from ?? Number.MAX_SAFE_INTEGER
    return [...wanted].sort((a, b) => at(a) - at(b))
  }, [all, filter, ranges])

  // Highlight open threads, and a resolved one while it is selected in the resolved list.
  useEffect(() => {
    if (!editor) return
    const shown = all
      .filter((t) => !t.resolved_at || (filter === 'resolved' && t.id === active))
      .map((t) => ({ id: t.id, start: t.anchor_start, end: t.anchor_end }))
    showThreads(editor, shown, active)
  }, [editor, all, active, filter])

  // Ctrl+Alt+M (Cmd+Option+M) comments on the selection, as in Google Docs. Listened for on the
  // window: a read-only editor, which is what commenters get, takes no keyboard input itself.
  const onShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (event.code !== 'KeyM' || !event.altKey || !(event.ctrlKey || event.metaKey)) return
    // AltGr arrives as Ctrl+Alt on Windows, and AltGr+M types a character on some layouts (µ).
    if (event.getModifierState('AltGraph')) return
    event.preventDefault()
    startComment()
  })
  useEffect(() => {
    if (!canComment) return
    globalThis.addEventListener('keydown', onShortcut)
    return () => globalThis.removeEventListener('keydown', onShortcut)
  }, [canComment])

  // Scroll to the linked thread once its passage is highlighted (or known to be deleted).
  useEffect(() => {
    if (!revealLinked.current || !editor || !linked || !ranges || !(linked.id in ranges)) return
    revealLinked.current = false
    const range = ranges[linked.id]
    if (range) revealPassage(editor, range)
  }, [editor, linked, ranges])

  function select(threadId: string | null, reveal = false) {
    setActive(threadId)
    const range = threadId ? ranges?.[threadId] : null
    if (reveal && editor && range) revealPassage(editor, range)
  }

  function startComment() {
    if (!editor || !canComment) return
    const anchor = anchorSelection(editor.state)
    if (!anchor) {
      setHint('Select the text you want to comment on first.')
      return
    }
    setHint(null)
    setDraft(anchor)
    setActive(null)
    setFilter('open')
  }

  return {
    documentId,
    branchId,
    threads,
    visible,
    counts,
    filter,
    setFilter,
    ranges: ranges ?? NO_RANGES,
    active,
    select,
    draft,
    cancelDraft: () => setDraft(null),
    startComment,
    hint,
    canComment,
    editorHandlers: {
      onSelect: (threadId) => {
        setActive(threadId)
        setFilter(all.find((t) => t.id === threadId)?.resolved_at ? 'resolved' : 'open')
      },
    },
  }
}
