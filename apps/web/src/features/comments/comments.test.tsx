import type { Editor } from '@tiptap/core'
import { screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { encodeBase64 } from '../../lib/base64'
import { ADA, BOB, makeDocument, signedIn } from '../../test/fixtures'
import { renderApp } from '../../test/renderApp'
import { server } from '../../test/server'
import type { Role } from '../documents/api'
import { CollabProvider, type CollabState } from '../editor/CollabProvider'
import type { Comment, Thread } from './api'

const live: { role: Role; provider: CollabProvider | null } = { role: 'owner', provider: null }

vi.mock('../editor/useCollab', () => ({
  useCollab: (documentId: string) => {
    live.provider ??= withText(
      new CollabProvider(documentId, {
        getTicket: async () => ({ ticket: 't', role: live.role }),
        socketUrl: () => 'ws://unused',
        openLocalStore: () => null,
      }),
    )
    const state: CollabState = {
      status: 'online',
      synced: true,
      localReady: true,
      unsynced: 0,
      role: live.role,
      stopReason: null,
      peers: [],
    }
    return { provider: live.provider, state }
  },
}))

const PARAGRAPHS = ['Intro to the plan', 'The budget is 10k this quarter.']

/** The document as the server would have sent it. */
function withText(provider: CollabProvider): CollabProvider {
  provider.doc.getXmlFragment('default').insert(
    0,
    PARAGRAPHS.map((text) => {
      const paragraph = new Y.XmlElement('paragraph')
      paragraph.insert(0, [new Y.XmlText(text)])
      return paragraph
    }),
  )
  return provider
}

/** An anchor pointing into a paragraph's text, encoded as the browser stores it. */
function anchorAt(paragraph: number, offset: number): string {
  const block = live.provider!.doc.getXmlFragment('default').get(paragraph) as Y.XmlElement
  const text = block.get(0) as Y.XmlText
  return encodeBase64(
    Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, offset, -1)),
  )
}

const document = makeDocument()
const base = `*/api/documents/${document.id}`

function comment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 'c1',
    author: { id: BOB.id, name: BOB.name },
    body: 'Is this number right?',
    created_at: new Date().toISOString(),
    edited_at: null,
    can_edit: false,
    can_delete: true,
    ...overrides,
  }
}

function thread(overrides: Partial<Thread> = {}): Thread {
  const start = 'The budget is 10k'.indexOf('budget')
  return {
    id: 't1',
    branch_id: null,
    anchor_start: anchorAt(1, start),
    anchor_end: anchorAt(1, start + 'budget is 10k'.length),
    quoted_text: 'budget is 10k',
    created_at: new Date().toISOString(),
    resolved_at: null,
    resolved_by: null,
    comments: [comment()],
    can_reply: true,
    ...overrides,
  }
}

function openDocument(threads: () => Thread[], path = `/d/${document.id}`) {
  const fetches = { count: 0 }
  server.use(
    signedIn(),
    http.get(base, () => HttpResponse.json({ ...document, role: live.role })),
    http.get(`${base}/threads`, () => {
      fetches.count += 1
      return HttpResponse.json(threads())
    }),
  )
  return { ...renderApp(path), fetches }
}

async function liveEditor(): Promise<Editor> {
  const body = await screen.findByRole('textbox', { name: 'Document body' })
  return (body as HTMLElement & { editor: Editor }).editor
}

function highlights(): string[] {
  return [...window.document.querySelectorAll('.comment-highlight')].map((el) => el.textContent!)
}

beforeEach(() => {
  live.role = 'owner'
  live.provider = null
})

describe('comments', () => {
  it('shows threads on their passages, and replies and resolves', async () => {
    let posted: unknown = null
    let resolved: unknown = null
    server.use(
      http.post(`${base}/threads/t1/comments`, async ({ request }) => {
        posted = await request.json()
        return HttpResponse.json(thread(), { status: 201 })
      }),
      http.patch(`${base}/threads/t1`, async ({ request }) => {
        resolved = await request.json()
        return HttpResponse.json(thread({ resolved_at: new Date().toISOString() }))
      }),
    )
    const { user } = openDocument(() => [thread()])

    const card = await screen.findByRole('article', { name: 'Comment on “budget is 10k”' })
    expect(within(card).getByText('Is this number right?')).toBeInTheDocument()
    expect(within(card).getByText(BOB.name)).toBeInTheDocument()
    await waitFor(() => expect(highlights()).toEqual(['budget is 10k']))
    expect(screen.getByRole('button', { name: 'Open (1)' })).toHaveAttribute('aria-pressed', 'true')

    // From the keyboard: Tab to the thread and open it.
    within(card).getByRole('button', { name: 'Show in document' }).focus()
    await user.keyboard('{Enter}')
    expect(card).toHaveAttribute('aria-current', 'true')
    await user.type(within(card).getByRole('textbox', { name: 'Reply' }), '  Yes, checked.  ')
    await user.click(within(card).getByRole('button', { name: 'Reply' }))
    await waitFor(() => expect(posted).toEqual({ body: 'Yes, checked.' }))

    await user.click(within(card).getByRole('button', { name: 'Resolve' }))
    await waitFor(() => expect(resolved).toEqual({ resolved: true }))
  })

  it('opens a thread on the selected text', async () => {
    let created: Record<string, unknown> | null = null
    const threads: Thread[] = []
    server.use(
      http.post(`${base}/threads`, async ({ request }) => {
        created = (await request.json()) as Record<string, unknown>
        const opened = thread({
          id: 't-new',
          anchor_start: String(created.anchor_start),
          anchor_end: String(created.anchor_end),
          quoted_text: String(created.quoted_text),
          comments: [comment({ author: { id: ADA.id, name: ADA.name }, body: 'Too low?' })],
        })
        threads.push(opened)
        return HttpResponse.json(opened, { status: 201 })
      }),
    )
    const { user } = openDocument(() => threads)
    const editor = await liveEditor()

    // Nothing selected yet: say what to do.
    await user.click(screen.getByRole('button', { name: 'Add comment' }))
    expect(screen.getByText('Select the text you want to comment on first.')).toBeInTheDocument()

    let from = -1
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text!.includes('10k')) from = pos + node.text!.indexOf('10k')
    })
    editor.commands.setTextSelection({ from, to: from + '10k'.length })
    await user.keyboard('{Control>}{Alt>}m{/Alt}{/Control}') // the Google Docs shortcut

    const form = screen.getByRole('form', { name: 'New comment' })
    expect(within(form).getByText('10k')).toBeInTheDocument()
    await user.type(within(form).getByRole('textbox', { name: 'Comment' }), 'Too low?')
    await user.click(within(form).getByRole('button', { name: 'Comment' }))

    await waitFor(() =>
      expect(created).toMatchObject({ quoted_text: '10k', body: 'Too low?', branch_id: null }),
    )
    expect(await screen.findByRole('article', { name: 'Comment on “10k”' })).toHaveAttribute(
      'aria-current',
      'true',
    )
    await waitFor(() => expect(highlights()).toEqual(['10k']))
    expect(screen.queryByRole('form', { name: 'New comment' })).toBeNull()
  })

  it('lets viewers read but not comment', async () => {
    live.role = 'viewer'
    const { user } = openDocument(() => [thread({ can_reply: false })])

    const card = await screen.findByRole('article', { name: 'Comment on “budget is 10k”' })
    await user.click(card)

    expect(screen.queryByRole('button', { name: 'Add comment' })).toBeNull()
    expect(within(card).queryByRole('textbox', { name: 'Reply' })).toBeNull()
  })

  it('fetches again when the server says comments changed', async () => {
    const { fetches } = openDocument(() => [])
    expect(await screen.findByText(/No comments yet/)).toBeInTheDocument()
    await waitFor(() => expect(fetches.count).toBeGreaterThan(0))
    const before = fetches.count

    live.provider!['receive'](new Uint8Array([121]))

    await waitFor(() => expect(fetches.count).toBe(before + 1))
  })

  it('opens on the thread a notification linked to, even when resolved', async () => {
    const resolvedAt = new Date().toISOString()
    openDocument(
      () => [
        thread(),
        thread({ id: 't2', quoted_text: 'Intro', resolved_at: resolvedAt, resolved_by: ADA }),
      ],
      `/d/${document.id}?thread=t2`,
    )

    const card = await screen.findByRole('article', { name: 'Comment on “Intro”' })
    expect(card).toHaveAttribute('aria-current', 'true')
    expect(within(card).getByText(/Resolved by Ada Lovelace/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resolved (1)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('says when the commented text was deleted', async () => {
    // Anchors into a paragraph nobody has: as if the text was removed.
    const gone = encodeBase64(
      Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(new Y.Doc().getText('x'), 0)),
    )
    openDocument(() => [thread({ anchor_start: gone, anchor_end: gone })])

    const card = await screen.findByRole('article', { name: 'Comment on “budget is 10k”' })
    expect(
      await within(card).findByText('The text this was about was deleted.'),
    ).toBeInTheDocument()
    expect(highlights()).toEqual([])
  })

  it('asks before deleting a whole thread', async () => {
    let deleted = false
    server.use(
      http.delete(`${base}/comments/c1`, () => {
        deleted = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const { user } = openDocument(() => (deleted ? [] : [thread()]))

    const card = await screen.findByRole('article', { name: 'Comment on “budget is 10k”' })
    await user.click(within(card).getByRole('button', { name: 'Delete' }))
    expect(within(card).getByText('Delete the whole thread?')).toBeInTheDocument()
    expect(deleted).toBe(false)
    await user.click(within(card).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(deleted).toBe(true))
    expect(await screen.findByText(/No comments yet/)).toBeInTheDocument()
  })
})
