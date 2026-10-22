import type { Extensions } from '@tiptap/core'
import Image from '@tiptap/extension-image'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { CharacterCount } from '@tiptap/extensions'
import StarterKit from '@tiptap/starter-kit'

/**
 * The document schema: every editor that opens a document (live, version preview) uses the same
 * nodes, or a node one of them lacks would be dropped when it loads the shared Yjs state.
 */
export function documentExtensions(): Extensions {
  return [
    // Collaboration brings its own undo, which only reverts your own changes: undoing must never
    // erase what someone else typed. So the default history is switched off.
    StarterKit.configure({ undoRedo: false, link: { openOnClick: false, autolink: true } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    // Column widths would be one more thing to merge between people; tables size themselves.
    TableKit.configure({ table: { resizable: false } }),
    // Images by address only: pasted image data would put megabytes into every edit and snapshot.
    Image.configure({ allowBase64: false }),
    CharacterCount,
  ]
}

/** Whether an address is one an image or a link may point at: no javascript: or data: URLs. */
export function isWebAddress(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}
