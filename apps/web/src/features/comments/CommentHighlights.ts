import { Extension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { ySyncPluginKey } from '@tiptap/y-tiptap'
import { resolveAnchor, type Range } from './anchors'

export interface AnchoredThread {
  id: string
  start: string
  end: string
}

interface HighlightState {
  threads: AnchoredThread[]
  active: string | null
  /** Where each thread's passage is now; null when its text was deleted. */
  ranges: Map<string, Range | null>
  decorations: DecorationSet
}

export const commentHighlightsKey = new PluginKey<HighlightState>('commentHighlights')

export interface CommentHandlers {
  /** A highlighted passage was clicked. */
  onSelect: (threadId: string) => void
}

function decorate(
  state: EditorState,
  ranges: Map<string, Range | null>,
  active: string | null,
): DecorationSet {
  const decorations: Decoration[] = []
  for (const [id, range] of ranges) {
    if (!range) continue
    decorations.push(
      Decoration.inline(range.from, range.to, {
        class: id === active ? 'comment-highlight comment-highlight-active' : 'comment-highlight',
        'data-thread-id': id,
      }),
    )
  }
  return DecorationSet.create(state.doc, decorations)
}

/** Where every thread's passage is, worked out from its anchors. */
function resolveAll(state: EditorState, threads: AnchoredThread[]): Map<string, Range | null> {
  return new Map(
    threads.map((thread) => [thread.id, resolveAnchor(state, thread.start, thread.end)]),
  )
}

/** Moves the passages through a local edit. Text typed at either edge stays outside. */
function mapAll(tr: Transaction, ranges: Map<string, Range | null>): Map<string, Range | null> {
  const moved = new Map<string, Range | null>()
  for (const [id, range] of ranges) {
    if (!range) {
      moved.set(id, null)
      continue
    }
    const from = tr.mapping.map(range.from, 1)
    const to = tr.mapping.map(range.to, -1)
    moved.set(id, from < to && tr.doc.textBetween(from, to, '', '').trim() ? { from, to } : null)
  }
  return moved
}

/**
 * Highlights the passages open comment threads point at. The highlights are decorations, drawn
 * over the text rather than stored in it, and are worked out again from the threads' anchors
 * after every change: local typing, remote edits and offline edits arriving all move them.
 */
export const CommentHighlights = Extension.create<object, CommentHandlers>({
  name: 'commentHighlights',

  // The page swaps in its handlers whenever it renders (setCommentHandlers): the editor outlives
  // any one render, so handlers fixed when it was built would go stale.
  addStorage() {
    return { onSelect: () => {} }
  },

  addProseMirrorPlugins() {
    const handlers = this.storage
    return [
      new Plugin<HighlightState>({
        key: commentHighlightsKey,
        state: {
          init: (_, state) => ({
            threads: [],
            active: null,
            ranges: new Map(),
            decorations: DecorationSet.create(state.doc, []),
          }),
          apply: (tr, value, _old, state) => {
            const meta = tr.getMeta(commentHighlightsKey) as
              Partial<Pick<HighlightState, 'threads' | 'active'>> | undefined
            const fromYjs = Boolean(
              (tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)
                ?.isChangeOrigin,
            )
            if (!meta && !fromYjs && !tr.docChanged) return value
            const threads = meta?.threads ?? value.threads
            const active = meta && 'active' in meta ? (meta.active ?? null) : value.active
            // A local edit reaches Yjs only after this transaction, so anchors would still resolve
            // against the text before it: move the known passages through the edit instead. New
            // threads, and changes that came through Yjs (remote, undo), resolve afresh.
            const ranges =
              meta?.threads || fromYjs ? resolveAll(state, threads) : mapAll(tr, value.ranges)
            return { threads, active, ranges, decorations: decorate(state, ranges, active) }
          },
        },
        props: {
          decorations: (state) => commentHighlightsKey.getState(state)?.decorations,
          handleClick: (view, pos) => {
            const ranges = commentHighlightsKey.getState(view.state)?.ranges
            if (!ranges) return false
            // The innermost (shortest) passage wins where threads overlap.
            let hit: { id: string; length: number } | null = null
            for (const [id, range] of ranges) {
              if (range && range.from <= pos && pos <= range.to) {
                const length = range.to - range.from
                if (!hit || length < hit.length) hit = { id, length }
              }
            }
            if (hit) handlers.onSelect(hit.id)
            return false // let the click place the cursor as usual
          },
        },
      }),
    ]
  },
})

declare module '@tiptap/core' {
  interface Storage {
    commentHighlights: CommentHandlers
  }
}

export function setCommentHandlers(editor: Editor, handlers: CommentHandlers) {
  // Missing while an editor is being replaced (a new provider builds a new editor).
  const storage = editor.storage.commentHighlights as CommentHandlers | undefined
  if (storage) Object.assign(storage, handlers)
}

/** Shows these threads' passages, with `active` emphasised. */
export function showThreads(editor: Editor, threads: AnchoredThread[], active: string | null) {
  if (editor.isDestroyed) return
  // Never part of anyone's undo history: highlighting changes nothing in the document.
  editor.view.dispatch(
    editor.state.tr
      .setMeta(commentHighlightsKey, { threads, active })
      .setMeta('addToHistory', false),
  )
}

export function threadRanges(state: EditorState): Map<string, Range | null> {
  return commentHighlightsKey.getState(state)?.ranges ?? new Map()
}
