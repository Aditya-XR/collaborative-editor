import type { EditorState } from '@tiptap/pm/state'
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from '@tiptap/y-tiptap'
import * as Y from 'yjs'
import { decodeBase64, encodeBase64 } from '../../lib/base64'

/**
 * Comments point at text with Yjs relative positions (ADR 0017). A relative position names a
 * character by its CRDT id rather than by its offset, so it stays on the same words however much
 * text anyone inserts or deletes around them, offline edits included, and making one never edits
 * the document: commenters cannot.
 */

/** The longest quote kept with a thread; the server allows 500 characters. */
export const MAX_QUOTE = 300

export interface Anchor {
  start: string
  end: string
  quote: string
}

export interface Range {
  from: number
  to: number
}

interface SyncState {
  doc: Y.Doc
  type: Y.XmlFragment
  binding: { mapping: Map<unknown, unknown> } | null
}

function syncState(state: EditorState): SyncState | null {
  const sync = ySyncPluginKey.getState(state) as SyncState | undefined
  return sync?.binding ? sync : null
}

/** The selected passage as an anchor, or null when nothing is selected. */
export function anchorSelection(state: EditorState): Anchor | null {
  const { from, to, empty } = state.selection
  const sync = syncState(state)
  if (empty || !sync) return null
  const quote = state.doc.textBetween(from, to, ' ', ' ').replace(/\s+/g, ' ').trim()
  if (!quote) return null // a selection of nothing but structure (an empty line)
  const encode = (pos: number) =>
    encodeBase64(
      Y.encodeRelativePosition(
        absolutePositionToRelativePosition(pos, sync.type, sync.binding!.mapping as never),
      ),
    )
  return {
    start: encode(from),
    end: encode(to),
    quote: quote.length > MAX_QUOTE ? `${quote.slice(0, MAX_QUOTE - 1)}…` : quote,
  }
}

/**
 * Where an anchor is in the document now, or null when its text is gone (deleted, or never
 * received on this device) and only the thread's quote is left to show.
 */
export function resolveAnchor(state: EditorState, start: string, end: string): Range | null {
  const sync = syncState(state)
  if (!sync) return null
  try {
    const at = (encoded: string) =>
      relativePositionToAbsolutePosition(
        sync.doc,
        sync.type,
        Y.decodeRelativePosition(decodeBase64(encoded)),
        sync.binding!.mapping as never,
      )
    const from = at(start)
    const to = at(end)
    if (from === null || to === null || from >= to) return null
    // A passage whose every character was deleted collapses to an empty stretch.
    if (!state.doc.textBetween(from, to, '', '').trim()) return null
    return { from, to }
  } catch {
    return null // not a relative position this client can read
  }
}
