import { screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { encodeBase64 } from '../../lib/base64'
import { ADA, BOB, apiError, makeDocument, signedIn } from '../../test/fixtures'
import { renderApp } from '../../test/renderApp'
import { server } from '../../test/server'
import type { Role } from '../documents/api'
import { CollabProvider, type CollabDeps, type CollabState } from '../editor/CollabProvider'
import { collabDeps } from '../editor/useCollab'
import type { Branch, Review } from './api'

const live: { role: Role; providers: Map<string, CollabProvider> } = {
  role: 'owner',
  providers: new Map(),
}

vi.mock('../editor/useCollab', async (importOriginal) => {
  const original = await importOriginal<typeof import('../editor/useCollab')>()
  return {
    ...original,
    useCollab: (documentId: string, _user: unknown, branchId: string | null = null) => {
      const stream = branchId ?? documentId
      let provider = live.providers.get(stream)
      if (!provider) {
        provider = new CollabProvider(stream, deps)
        live.providers.set(stream, provider)
      }
      const state: CollabState = {
        status: 'online',
        synced: true,
        localReady: true,
        unsynced: 0,
        role: live.role,
        stopReason: null,
        peers: [],
      }
      return { provider, state }
    },
  }
})

const deps: CollabDeps = {
  getTicket: async () => ({ ticket: 't', role: 'owner' }),
  socketUrl: () => 'ws://unused',
  openLocalStore: () => null,
}

const document = makeDocument()

function makeBranch(overrides: Partial<Branch> = {}): Branch {
  const now = new Date().toISOString()
  return {
    id: 'br-1',
    document_id: document.id,
    name: 'Tighter intro',
    description: '',
    status: 'open',
    created_by: { id: ADA.id, name: ADA.name },
    created_at: now,
    updated_at: now,
    review_requested_at: null,
    merged_by: null,
    merged_at: null,
    closed_at: null,
    can_edit: true,
    can_merge: true,
    ...overrides,
  }
}

function yjsState(...paragraphs: string[]): string {
  const doc = new Y.Doc()
  doc.getXmlFragment('default').insert(
    0,
    paragraphs.map((text) => {
      const paragraph = new Y.XmlElement('paragraph')
      paragraph.insert(0, [new Y.XmlText(text)])
      return paragraph
    }),
  )
  return encodeBase64(Y.encodeStateAsUpdate(doc))
}

function makeReview(overrides: Partial<Review> = {}): Review {
  return {
    branch: makeBranch(),
    changes: [{ kind: 'changed', base: ['Intro'], main: ['Intro'], branch: ['A sharper intro'] }],
    conflicts: 0,
    head: 'head-1',
    preview: yjsState('A sharper intro', 'Budget'),
    ...overrides,
  }
}

const base = `*/api/documents/${document.id}`

function documentEndpoints(role: Role = 'owner') {
  return [
    signedIn(),
    http.get(base, () => HttpResponse.json({ ...document, role })),
    http.get(`${base}/branches/:branchId`, ({ params }) =>
      HttpResponse.json(makeBranch({ id: String(params.branchId) })),
    ),
  ]
}

beforeEach(() => {
  live.role = 'owner'
  live.providers.clear()
})

describe('branches dialog', () => {
  it('lists branches and opens a new one after creating it', async () => {
    let created: unknown = null
    server.use(
      http.get(`${base}/branches`, () =>
        HttpResponse.json([
          makeBranch({ review_requested_at: new Date().toISOString() }),
          makeBranch({ id: 'br-2', name: 'Old idea', status: 'closed', can_edit: false }),
        ]),
      ),
      http.post(`${base}/branches`, async ({ request }) => {
        created = await request.json()
        return HttpResponse.json(makeBranch({ id: 'br-new', name: 'Budget pass' }), {
          status: 201,
        })
      }),
      ...documentEndpoints(),
    )
    const { user, router } = renderApp(`/d/${document.id}`)

    await user.click(await screen.findByRole('button', { name: 'Branches' }))
    const dialog = await screen.findByRole('dialog', { name: 'Branches' })
    const list = await within(dialog).findByRole('list')
    expect(within(list).getByRole('link', { name: 'Tighter intro' })).toHaveAttribute(
      'href',
      `/d/${document.id}/b/br-1`,
    )
    expect(within(list).getByText(/review requested/)).toBeInTheDocument()
    expect(within(list).getByText('Closed')).toBeInTheDocument()

    await user.type(within(dialog).getByRole('textbox', { name: 'New branch name' }), 'Budget pass')
    await user.click(within(dialog).getByRole('button', { name: 'Create branch' }))

    await waitFor(() => expect(router.state.location.pathname).toBe(`/d/${document.id}/b/br-new`))
    expect(created).toEqual({ name: 'Budget pass' })
  })

  it('lets viewers look but not branch', async () => {
    live.role = 'viewer'
    server.use(
      http.get(`${base}/branches`, () => HttpResponse.json([])),
      ...documentEndpoints('viewer'),
    )
    const { user } = renderApp(`/d/${document.id}`)

    await user.click(await screen.findByRole('button', { name: 'Branches' }))
    const dialog = await screen.findByRole('dialog', { name: 'Branches' })

    expect(await within(dialog).findByText('No branches yet.')).toBeInTheDocument()
    expect(within(dialog).queryByRole('textbox', { name: 'New branch name' })).toBeNull()
  })
})

describe('branch page', () => {
  it('edits the branch and takes the document’s latest changes on request', async () => {
    let updated = false
    server.use(
      http.post(`${base}/branches/br-1/update-from-main`, () => {
        updated = true
        return HttpResponse.json(makeBranch())
      }),
      ...documentEndpoints(),
    )
    const { user } = renderApp(`/d/${document.id}/b/br-1`)

    expect(await screen.findByRole('heading', { name: 'Tighter intro' })).toBeInTheDocument()
    const body = await screen.findByRole('textbox', { name: 'Document body' })
    expect(body).toHaveAttribute('contenteditable', 'true')
    expect(screen.getByRole('link', { name: 'Review and merge' })).toHaveAttribute(
      'href',
      `/d/${document.id}/b/br-1/review`,
    )

    await user.click(screen.getByRole('button', { name: 'Update from main' }))
    await user.click(screen.getByRole('button', { name: 'Update' }))

    await waitFor(() => expect(updated).toBe(true))
    expect(
      await screen.findByText('This branch now includes the document’s latest changes.'),
    ).toBeInTheDocument()
  })

  it('is read-only once merged, and says so', async () => {
    live.role = 'viewer' // what the fresh ticket of a merged branch says
    server.use(
      http.get(`${base}/branches/br-1`, () =>
        HttpResponse.json(
          makeBranch({
            status: 'merged',
            can_edit: false,
            can_merge: false,
            merged_by: { id: BOB.id, name: BOB.name },
            merged_at: new Date().toISOString(),
          }),
        ),
      ),
      ...documentEndpoints(),
    )
    renderApp(`/d/${document.id}/b/br-1`)

    expect(await screen.findByText(/Merged into the document by Bob/)).toHaveTextContent(
      'read-only',
    )
    expect(await screen.findByRole('textbox', { name: 'Document body' })).toHaveAttribute(
      'contenteditable',
      'false',
    )
    expect(screen.queryByRole('button', { name: 'Update from main' })).toBeNull()
  })

  it('asks for review with a description', async () => {
    let sent: unknown = null
    server.use(
      http.patch(`${base}/branches/br-1`, async ({ request }) => {
        sent = await request.json()
        return HttpResponse.json(makeBranch({ review_requested_at: new Date().toISOString() }))
      }),
      ...documentEndpoints(),
    )
    const { user } = renderApp(`/d/${document.id}/b/br-1`)

    await user.click(await screen.findByRole('button', { name: 'Request review' }))
    await user.type(
      screen.getByRole('textbox', { name: 'What does this branch change, and why?' }),
      'Shorter intro',
    )
    await user.click(screen.getAllByRole('button', { name: 'Request review' }).at(-1)!)

    await waitFor(() =>
      expect(sent).toEqual({ review_requested: true, description: 'Shorter intro' }),
    )
  })
})

describe('review page', () => {
  it('shows the changes and the document after merging, then merges', async () => {
    let mergedWith: unknown = null
    server.use(
      http.get(`${base}/branches/br-1/review`, () => HttpResponse.json(makeReview())),
      http.post(`${base}/branches/br-1/merge`, async ({ request }) => {
        mergedWith = await request.json()
        return HttpResponse.json(makeBranch({ status: 'merged' }))
      }),
      ...documentEndpoints(),
    )
    const { user, router } = renderApp(`/d/${document.id}/b/br-1/review`)

    const changes = await screen.findByRole('region', { name: 'Changes' })
    const card = within(changes).getByRole('article', { name: 'Changed' })
    expect(within(card).getByText('Intro')).toBeInTheDocument()
    expect(within(card).getByText('A sharper intro')).toBeInTheDocument()
    const preview = await screen.findByRole('textbox', { name: 'Version preview' })
    await waitFor(() => expect(preview).toHaveTextContent('A sharper introBudget'))

    await user.click(screen.getByRole('button', { name: 'Merge into the document' }))
    await user.click(screen.getByRole('button', { name: 'Merge' }))

    await waitFor(() => expect(router.state.location.pathname).toBe(`/d/${document.id}`))
    expect(mergedWith).toEqual({ head: 'head-1' })
    expect(await screen.findByText(/Merged “Tighter intro” into this document/)).toBeInTheDocument()
  })

  it('blocks the merge while passages conflict', async () => {
    server.use(
      http.get(`${base}/branches/br-1/review`, () =>
        HttpResponse.json(
          makeReview({
            conflicts: 1,
            changes: [{ kind: 'conflict', base: ['Budget'], main: [], branch: ['Budget is 10k'] }],
          }),
        ),
      ),
      ...documentEndpoints(),
    )
    renderApp(`/d/${document.id}/b/br-1/review`)

    const conflict = await screen.findByRole('article', { name: 'Conflict' })
    expect(within(conflict).getByText('Deleted in the document')).toBeInTheDocument()
    expect(within(conflict).getByText('Budget is 10k')).toBeInTheDocument()
    expect(screen.getByText(/Can’t merge yet/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Merge into the document' })).toBeNull()
  })

  it('reviews again when the branch changed since it was loaded', async () => {
    let reviews = 0
    server.use(
      http.get(`${base}/branches/br-1/review`, () => {
        reviews += 1
        return HttpResponse.json(makeReview({ head: `head-${reviews}` }))
      }),
      http.post(`${base}/branches/br-1/merge`, () =>
        apiError(
          409,
          'branch_changed',
          'The branch changed since you reviewed it. Review it again.',
        ),
      ),
      ...documentEndpoints(),
    )
    const { user } = renderApp(`/d/${document.id}/b/br-1/review`)

    await user.click(await screen.findByRole('button', { name: 'Merge into the document' }))
    await user.click(screen.getByRole('button', { name: 'Merge' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('changed since you reviewed it')
    await waitFor(() => expect(reviews).toBe(2))
  })

  it('tells commenters who can merge', async () => {
    live.role = 'commenter'
    server.use(
      http.get(`${base}/branches/br-1/review`, () =>
        HttpResponse.json(makeReview({ branch: makeBranch({ can_merge: false }) })),
      ),
      ...documentEndpoints('commenter'),
    )
    renderApp(`/d/${document.id}/b/br-1/review`)

    expect(
      await screen.findByText(/Only an owner or editor of the document can merge/),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Merge into the document' })).toBeNull()
  })
})

describe('branch connection', () => {
  it('asks for a ticket to the branch, on the document’s socket', async () => {
    let body: unknown = null
    server.use(
      http.post('*/api/collab/tickets', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ ticket: 'tk', role: 'editor', expires_in: 30 })
      }),
    )
    const branchDeps = collabDeps('u-1', 'doc-1', 'br-1')

    await branchDeps.getTicket('br-1')

    expect(body).toEqual({ document_id: 'doc-1', branch_id: 'br-1' })
    expect(branchDeps.socketUrl('br-1', 'tk')).toMatch(/\/api\/ws\/docs\/doc-1\?ticket=tk$/)
  })
})
