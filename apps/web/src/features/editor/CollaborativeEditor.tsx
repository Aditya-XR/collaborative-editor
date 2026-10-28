import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import { useEffect } from 'react'
import type { User } from '../auth/session'
import {
  CommentHighlights,
  setCommentHandlers,
  type CommentHandlers,
} from '../comments/CommentHighlights'
import { colorFor } from './colors'
import { documentExtensions } from './extensions'
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
        ...documentExtensions(),
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
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 print:overflow-visible print:rounded-none print:border-0">
      {editable && (
        <div className="print:hidden">
          <Toolbar editor={editor} />
        </div>
      )}
      <EditorContent editor={editor} />
      <WordCount editor={editor} />
    </div>
  )
}

function WordCount({ editor }: { editor: Editor }) {
  const { words, characters } = useEditorState({
    editor,
    // A destroyed editor has empty storage, and React can render this once more with the old
    // editor after it was replaced (a new provider, StrictMode): count nothing then.
    selector: ({ editor: e }) => ({
      words: e.storage.characterCount?.words() ?? 0,
      characters: e.storage.characterCount?.characters() ?? 0,
    }),
  })
  return (
    <p className="border-t border-slate-100 px-8 py-2 text-xs print:hidden text-slate-500 dark:border-slate-800 dark:text-slate-400">
      {words.toLocaleString()} {words === 1 ? 'word' : 'words'} · {characters.toLocaleString()}{' '}
      {characters === 1 ? 'character' : 'characters'}
    </p>
  )
}
