import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect } from 'react'
import type { User } from '../auth/session'
import {
  CommentHighlights,
  setCommentHandlers,
  type CommentHandlers,
} from '../comments/CommentHighlights'
import { colorFor } from './colors'
import type { CollabProvider } from './CollabProvider'
import { Toolbar } from './Toolbar'

export function CollaborativeEditor({
  provider,
  user,
  editable,
  onReady,
  comments,
}: {
  provider: CollabProvider
  user: User
  editable: boolean
  /** Hands the live editor to the page, which restores versions through it. */
  onReady?: (editor: Editor | null) => void
  /** What a click on a commented passage, and the comment shortcut, do. */
  comments?: CommentHandlers
}) {
  const editor = useEditor(
    {
      extensions: [
        // Collaboration brings its own undo, which only reverts your own changes: undoing must
        // never erase what someone else typed. So the default history is switched off.
        StarterKit.configure({ undoRedo: false }),
        Collaboration.configure({ document: provider.doc }),
        CollaborationCaret.configure({
          provider,
          user: { name: user.name, color: colorFor(user.id) },
        }),
        CommentHighlights,
      ],
      editable,
      editorProps: {
        // ProseMirror renders a bare contenteditable div; the role makes screen readers
        // announce it as a multi-line text field.
        attributes: {
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': 'Document body',
          class: 'prose-editor min-h-[60vh] px-8 py-6 outline-none',
        },
      },
    },
    [provider],
  )

  useEffect(() => {
    editor?.setEditable(editable)
  }, [editor, editable])

  useEffect(() => {
    if (editor && comments) setCommentHandlers(editor, comments)
  })

  useEffect(() => {
    onReady?.(editor)
    return () => onReady?.(null)
  }, [editor, onReady])

  if (!editor) return null
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      {editable && <Toolbar editor={editor} />}
      <EditorContent editor={editor} />
    </div>
  )
}
