import { Editor } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { anchorSelection, resolveAnchor, type Anchor } from './anchors'
import { CommentHighlights, showThreads, threadRanges } from './CommentHighlights'

const editors: Editor[] = []

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
})

/** A real editor bound to its own Yjs document, as in the app. */
function editorOn(doc: Y.Doc): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      Collaboration.configure({ document: doc }),
      CommentHighlights,
    ],
  })
  editors.push(editor)
  return editor
}

/** Two people's copies of one document, kept in sync the way the server relays updates. */
function pair(...paragraphs: string[]) {
  const mine = new Y.Doc()
  const theirs = new Y.Doc()
  theirs.getXmlFragment('default').insert(
    0,
    paragraphs.map((text) => {
      const paragraph = new Y.XmlElement('paragraph')
      paragraph.insert(0, [new Y.XmlText(text)])
      return paragraph
    }),
  )
  Y.applyUpdate(mine, Y.encodeStateAsUpdate(theirs))
  mine.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'relay') Y.applyUpdate(theirs, update, 'relay')
  })
  theirs.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'relay') Y.applyUpdate(mine, update, 'relay')
  })
  return { editor: editorOn(mine), theirs }
}

/** The document position where `text` starts. */
function positionOf(editor: Editor, text: string): number {
  let found = -1
  editor.state.doc.descendants((node, pos) => {
    if (found >= 0 || !node.isText) return found < 0
    const index = node.text!.indexOf(text)
    if (index >= 0) found = pos + index
    return false
  })
  if (found < 0) throw new Error(`"${text}" is not in the document`)
  return found
}

function select(editor: Editor, text: string): Anchor {
  const from = positionOf(editor, text)
  editor.commands.setTextSelection({ from, to: from + text.length })
  const anchor = anchorSelection(editor.state)
  expect(anchor).not.toBeNull()
  return anchor!
}

function quoted(editor: Editor, anchor: Anchor): string | null {
  const range = resolveAnchor(editor.state, anchor.start, anchor.end)
  return range && editor.state.doc.textBetween(range.from, range.to, '\n')
}

/** Another person's edit to the paragraph at `index`, made in their copy. */
function theyType(theirs: Y.Doc, index: number, offset: number, text: string) {
  const paragraph = theirs.getXmlFragment('default').get(index) as Y.XmlElement
  ;(paragraph.get(0) as Y.XmlText).insert(offset, text)
}

function highlighted(editor: Editor): string[] {
  return [...editor.view.dom.querySelectorAll('.comment-highlight')].map((el) => el.textContent!)
}

describe('comment anchors', () => {
  it('quote the selection and need one', () => {
    const { editor } = pair('The budget is 10k this quarter.')
    expect(anchorSelection(editor.state)).toBeNull() // just a cursor

    expect(select(editor, 'budget is 10k').quote).toBe('budget is 10k')
  })

  it('stay on their words through local and remote edits around them', () => {
    const { editor, theirs } = pair('Intro', 'The budget is 10k this quarter.')
    const anchor = select(editor, 'budget is 10k')

    editor.commands.insertContentAt(positionOf(editor, 'Intro'), 'Draft: ')
    theyType(theirs, 1, 0, 'Note: ')
    theyType(theirs, 1, 'Note: The budget is 10k'.length, ' (approx.)')

    expect(editor.getText()).toContain('Note: The budget is 10k (approx.) this quarter.')
    expect(quoted(editor, anchor)).toBe('budget is 10k')
  })

  it('grow with text typed inside the passage', () => {
    const { editor, theirs } = pair('The budget is 10k this quarter.')
    const anchor = select(editor, 'budget is 10k')

    theyType(theirs, 0, 'The budget'.length, ' (net)')

    expect(quoted(editor, anchor)).toBe('budget (net) is 10k')
  })

  it('resolve to nothing once the passage is deleted', () => {
    const { editor, theirs } = pair('Keep this.', 'The budget is 10k.')
    const anchor = select(editor, 'budget is 10k')

    theirs.getXmlFragment('default').delete(1, 1)

    expect(quoted(editor, anchor)).toBeNull()
  })

  it('ignore anchors that are not relative positions', () => {
    const { editor } = pair('Text')
    expect(resolveAnchor(editor.state, 'AAAA', 'not base64!')).toBeNull()
  })
})

describe('comment highlights', () => {
  it('mark open threads and follow every kind of edit', () => {
    const { editor, theirs } = pair('Intro', 'The budget is 10k this quarter.')
    const anchor = select(editor, 'budget is 10k')
    showThreads(editor, [{ id: 't1', start: anchor.start, end: anchor.end }], null)
    expect(highlighted(editor)).toEqual(['budget is 10k'])

    // Typed here: mapped through the edit, before Yjs has seen it.
    editor.commands.insertContentAt(positionOf(editor, 'Intro'), 'Draft: ')
    expect(highlighted(editor)).toEqual(['budget is 10k'])
    // Typed elsewhere: resolved again from the anchors.
    theyType(theirs, 1, 0, 'Note: ')
    expect(highlighted(editor)).toEqual(['budget is 10k'])
    // Typed right at the passage's edges: stays outside it.
    editor.commands.insertContentAt(positionOf(editor, 'budget'), 'net ')
    editor.commands.insertContentAt(positionOf(editor, ' this quarter'), '!')
    expect(editor.getText()).toContain('The net budget is 10k! this')
    expect(highlighted(editor)).toEqual(['budget is 10k'])
  })

  it('emphasise the selected thread and drop deleted passages', () => {
    const { editor } = pair('Alpha beta', 'Gamma delta')
    const first = select(editor, 'beta')
    const second = select(editor, 'Gamma')
    const threads = [
      { id: 'a', start: first.start, end: first.end },
      { id: 'b', start: second.start, end: second.end },
    ]
    showThreads(editor, threads, 'b')

    const active = editor.view.dom.querySelector('.comment-highlight-active')
    expect(active?.textContent).toBe('Gamma')
    expect(active?.getAttribute('data-thread-id')).toBe('b')

    const from = positionOf(editor, 'beta')
    editor.commands.deleteRange({ from, to: from + 'beta'.length })

    expect(highlighted(editor)).toEqual(['Gamma'])
    expect(threadRanges(editor.state).get('a')).toBeNull()
  })
})
