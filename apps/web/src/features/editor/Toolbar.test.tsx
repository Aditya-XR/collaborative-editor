import type { Editor } from '@tiptap/react'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ADA } from '../../test/fixtures'
import { CollabProvider } from './CollabProvider'
import { CollaborativeEditor } from './CollaborativeEditor'

/** A real editor on a provider that never connects: the toolbar works on its local document. */
async function renderEditor() {
  const provider = new CollabProvider('doc-1', {
    getTicket: async () => ({ ticket: 't', role: 'owner' }),
    socketUrl: () => 'ws://unused',
    openLocalStore: () => null,
  })
  let editor: Editor | null = null
  render(
    <CollaborativeEditor
      provider={provider}
      user={ADA}
      editable
      onReady={(ready) => {
        editor = ready
      }}
    />,
  )
  await screen.findByRole('textbox', { name: 'Document body' })
  return { editor: editor as unknown as Editor, user: userEvent.setup() }
}

const body = () => screen.getByRole('textbox', { name: 'Document body' })

describe('formatting toolbar', () => {
  it('inserts a table and edits its rows and columns', async () => {
    const { user } = await renderEditor()

    await user.click(screen.getByRole('button', { name: 'Table' }))

    const table = within(body()).getByRole('table')
    expect(within(table).getAllByRole('row')).toHaveLength(3)
    expect(within(table).getAllByRole('columnheader')).toHaveLength(3)
    const tableTools = screen.getByRole('toolbar', { name: 'Table' })
    await user.click(within(tableTools).getByRole('button', { name: 'Add row below' }))
    await user.click(within(tableTools).getByRole('button', { name: 'Add column right' }))
    expect(within(table).getAllByRole('row')).toHaveLength(4)
    expect(within(table).getAllByRole('columnheader')).toHaveLength(4)

    await user.click(within(tableTools).getByRole('button', { name: 'Delete table' }))
    expect(within(body()).queryByRole('table')).toBeNull()
    expect(screen.queryByRole('toolbar', { name: 'Table' })).toBeNull()
  })

  it('turns a line into a checklist', async () => {
    const { editor, user } = await renderEditor()
    act(() => {
      editor.commands.setContent('<p>Buy milk</p>')
    })

    await user.click(screen.getByRole('button', { name: 'Checklist' }))

    expect(screen.getByRole('button', { name: 'Checklist' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    const box = within(body()).getByRole('checkbox')
    expect(box).not.toBeChecked()
    expect(editor.getJSON().content?.[0].type).toBe('taskList')
  })

  it('links the selection, refusing addresses that are not web pages', async () => {
    const { editor, user } = await renderEditor()
    act(() => {
      editor.commands.setContent('<p>Read the brief</p>')
      editor.commands.setTextSelection({ from: 10, to: 15 })
    })

    await user.click(screen.getByRole('button', { name: 'Link' }))
    const address = screen.getByRole('textbox', { name: 'Link address' })
    await user.type(address, 'javascript:alert(1){Enter}')
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a full web address')
    expect(within(body()).queryByRole('link')).toBeNull()

    await user.clear(address)
    await user.type(address, 'https://example.com/brief{Enter}')
    const link = within(body()).getByRole('link', { name: 'brief' })
    expect(link).toHaveAttribute('href', 'https://example.com/brief')
    expect(screen.queryByRole('textbox', { name: 'Link address' })).toBeNull()
  })

  it('inserts an image from a web address only', async () => {
    const { editor, user } = await renderEditor()

    await user.click(screen.getByRole('button', { name: 'Image' }))
    await user.type(
      screen.getByRole('textbox', { name: 'Image address' }),
      'https://example.com/chart.png{Enter}',
    )

    const image = body().querySelector('img')
    expect(image).toHaveAttribute('src', 'https://example.com/chart.png')
    // Pasted image data is refused by the schema, not just by the form.
    act(() => {
      editor.commands.setContent('<img src="data:image/png;base64,AAAA">')
    })
    expect(body().querySelector('img')).toBeNull()
  })

  it('counts words and characters as the text changes', async () => {
    const { editor } = await renderEditor()
    expect(screen.getByText('0 words · 0 characters')).toBeInTheDocument()

    act(() => {
      editor.commands.setContent('<p>One two three</p><p>four</p>')
    })

    expect(screen.getByText('4 words · 17 characters')).toBeInTheDocument()
  })

  it('lists the keyboard shortcuts', async () => {
    const { user } = await renderEditor()

    await user.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }))
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' })
    expect(within(dialog).getByText('Comment on the selection')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
