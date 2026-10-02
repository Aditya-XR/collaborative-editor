import Collaboration from '@tiptap/extension-collaboration'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useMemo } from 'react'
import * as Y from 'yjs'
import { decodeBase64 } from '../../lib/base64'

/**
 * A version, read-only, rendered by the same editor as the live document: headings, lists and
 * marks look exactly as they did. The Yjs state goes into a private Y.Doc that nothing syncs.
 */
export function VersionPreview({
  state,
  onReady,
}: {
  state: string
  onReady: (editor: Editor | null) => void
}) {
  const doc = useMemo(() => {
    const versionDoc = new Y.Doc()
    Y.applyUpdate(versionDoc, decodeBase64(state))
    return versionDoc
  }, [state])
  useEffect(() => () => doc.destroy(), [doc])

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({ undoRedo: false }),
        Collaboration.configure({ document: doc }),
      ],
      editable: false,
      editorProps: {
        attributes: {
          role: 'textbox',
          'aria-readonly': 'true',
          'aria-multiline': 'true',
          'aria-label': 'Version preview',
          class: 'prose-editor px-6 py-4 outline-none',
        },
      },
    },
    [doc],
  )

  useEffect(() => {
    onReady(editor)
    return () => onReady(null)
  }, [editor, onReady])

  return <EditorContent editor={editor} />
}
