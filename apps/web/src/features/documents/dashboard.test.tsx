import { dehydrate, QueryClient } from '@tanstack/react-query'
import { screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { CollabProvider } from '../editor/CollabProvider'
import { renderApp } from '../../test/renderApp'
import { server } from '../../test/server'
import { ADA, apiError, BOB, makeDocument, readinessOk, signedIn } from '../../test/fixtures'
import { UNTITLED } from './queries'

const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// Opening a document starts a live connection; these tests only care about navigation.
// One provider per document, as the real hook memoizes it.
const providers = new Map<string, CollabProvider>()
function providerFor(documentId: string): CollabProvider {
  let provider = providers.get(documentId)
  if (!provider) {
    provider = new CollabProvider(documentId, {
      getTicket: async () => ({ ticket: 't', role: 'owner' }),
      socketUrl: () => 'ws://unused',
      openLocalStore: () => null,
    })
    providers.set(documentId, provider)
  }
  return provider
}

vi.mock('../editor/useCollab', async (importOriginal) => ({
  // The real connection setup, for downloading documents kept available offline.
  ...(await importOriginal<typeof import('../editor/useCollab')>()),
  useCollab: (documentId: string) => ({
    provider: providerFor(documentId),
    state: {
      status: 'online',
      synced: true,
      localReady: true,
      unsynced: 0,
      role: 'owner',
      stopReason: null,
      peers: [],
    },
  }),
}))

const mine = makeDocument({ id: 'doc-mine', title: 'My plan' })
const shared = makeDocument({
  id: 'doc-shared',
  title: "Bob's notes",
  role: 'editor',
  owner: { id: BOB.id, name: BOB.name },
})
const trashed = makeDocument({
  id: 'doc-old',
  title: 'Old draft',
  deleted_at: new Date().toISOString(),
})

/** A fake documents endpoint that honours the scope and trashed filters. */
function documentsEndpoint() {
  return http.get('*/api/documents', ({ request }) => {
    const params = new URL(request.url).searchParams
    if (params.get('trashed') === 'true') return HttpResponse.json([trashed])
    const scope = params.get('scope')
    if (scope === 'owned') return HttpResponse.json([mine])
    if (scope === 'shared') return HttpResponse.json([shared])
    return HttpResponse.json([shared, mine])
  })
}

function setup(...handlers: Parameters<typeof server.use>) {
  // Within one call the first matching handler wins: a test's own come before the defaults.
  server.use(...handlers, signedIn(), readinessOk(), documentsEndpoint())
  return renderApp('/')
}

describe('dashboard', () => {
  it('lists documents with owner and access details', async () => {
    setup()

    expect(await screen.findByText('My plan')).toBeInTheDocument()
    expect(screen.getByText("Bob's notes")).toBeInTheDocument()
    expect(screen.getByText(/You · Edited just now/)).toBeInTheDocument()
    expect(screen.getByText(/Bob · Edited just now · Can edit/)).toBeInTheDocument()
    // Only the owner may delete.
    expect(screen.getByRole('button', { name: 'Move My plan to trash' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: "Move Bob's notes to trash" })).toBeNull()
  })

  it('filters by view and keeps the view in the URL', async () => {
    const { user, router } = setup()
    await screen.findByText('My plan')

    await user.click(screen.getByRole('button', { name: 'Shared with me' }))

    await waitFor(() => expect(screen.queryByText('My plan')).toBeNull())
    expect(screen.getByText("Bob's notes")).toBeInTheDocument()
    expect(router.state.location.search).toBe('?view=shared')
  })

  it('creates a document under an id it chose, and opens it', async () => {
    const created: string[] = []
    const { user, router } = setup(
      http.put('*/api/documents/:id', ({ params }) => {
        created.push(String(params.id))
        return HttpResponse.json(makeDocument({ id: String(params.id), title: UNTITLED }), {
          status: 201,
        })
      }),
      http.get('*/api/documents/:id', ({ params }) =>
        HttpResponse.json(makeDocument({ id: String(params.id), title: UNTITLED })),
      ),
    )
    await screen.findByText('My plan')

    await user.click(screen.getByRole('button', { name: 'New document' }))

    expect(await screen.findByRole('heading', { name: UNTITLED })).toBeInTheDocument()
    expect(created).toHaveLength(1)
    expect(created[0]).toMatch(UUID7)
    expect(router.state.location.pathname).toBe(`/d/${created[0]}`)
  })

  it('creates a document after the browser said it went offline', async () => {
    const created: string[] = []
    const { user, router } = setup(
      http.put('*/api/documents/:id', ({ params }) => {
        created.push(String(params.id))
        return HttpResponse.json(makeDocument({ id: String(params.id), title: UNTITLED }), {
          status: 201,
        })
      }),
    )
    await screen.findByText('My plan')
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    // TanStack Query hears this too, and would hold every change until the network returns.
    globalThis.dispatchEvent(new Event('offline'))

    try {
      await user.click(screen.getByRole('button', { name: 'New document' }))
      expect(await screen.findByRole('heading', { name: UNTITLED })).toBeInTheDocument()
      expect(router.state.location.pathname).toMatch(/^\/d\//)
      expect(created).toEqual([]) // queued, not sent
    } finally {
      onLine.mockRestore()
      globalThis.dispatchEvent(new Event('online'))
    }
    await waitFor(() => expect(created).toEqual([router.state.location.pathname.slice(3)]))
  })

  it('creates a document offline, opens it, and sends it once the API answers', async () => {
    let reachable = false
    const created: string[] = []
    const { user, router } = setup(
      http.put('*/api/documents/:id', ({ params }) => {
        if (!reachable) return HttpResponse.error()
        created.push(String(params.id))
        return HttpResponse.json(makeDocument({ id: String(params.id), title: UNTITLED }), {
          status: 201,
        })
      }),
      http.get('*/api/documents/:id', ({ params }) =>
        HttpResponse.json(makeDocument({ id: String(params.id), title: UNTITLED })),
      ),
    )
    await screen.findByText('My plan')

    await user.click(screen.getByRole('button', { name: 'New document' }))

    // Made on this device: it opens at once, and the header counts it as not synced.
    expect(await screen.findByRole('heading', { name: UNTITLED })).toBeInTheDocument()
    const id = router.state.location.pathname.slice('/d/'.length)
    expect(id).toMatch(UUID7)
    expect(await screen.findByText(/^Offline/)).toHaveTextContent('1 change not synced')

    // The outbox retries with backoff; once the API answers, the same PUT lands, once.
    reachable = true
    await waitFor(() => expect(created).toEqual([id]), { timeout: 10_000 })
    await waitFor(() => expect(screen.queryByText(/^Offline|^Sending/)).toBeNull())
  })

  it('stars a document for the person who starred it', async () => {
    const starred: string[] = []
    const { user } = setup(
      http.put('*/api/documents/:id/star', ({ params }) => {
        starred.push(String(params.id))
        return HttpResponse.json({ ...mine, starred: true })
      }),
      // The list fetched again afterwards says what the server now holds.
      http.get('*/api/documents', () =>
        HttpResponse.json([shared, { ...mine, starred: starred.includes(mine.id) }]),
      ),
    )
    await screen.findByText('My plan')

    const star = screen.getByRole('button', { name: 'Star My plan' })
    expect(star).toHaveAttribute('aria-pressed', 'false')
    await user.click(star)

    expect(await screen.findByRole('button', { name: 'Unstar My plan' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(starred).toEqual(['doc-mine'])
  })

  it('keeps a document available offline when asked', async () => {
    const { user } = setup(
      // Downloading it for offline use connects once; refusing ends that quickly.
      http.post('*/api/collab/tickets', () => apiError(403, 'insufficient_role')),
      http.get('*/api/documents/doc-mine', () => HttpResponse.json(mine)),
    )
    await screen.findByText('My plan')

    const keep = screen.getByRole('button', { name: 'Make My plan available offline' })
    await user.click(keep)

    expect(keep).toHaveAttribute('aria-pressed', 'true')
    expect(JSON.parse(localStorage.getItem(`collabedit:${ADA.id}:pinned`)!)).toEqual(['doc-mine'])
  })

  it('opens offline with the lists this device saved', async () => {
    const saved = new QueryClient()
    saved.setQueryData(['documents', 'list', 'all'], [mine])
    localStorage.setItem(
      `collabedit:${ADA.id}:queries`,
      JSON.stringify({ version: 1, savedAt: Date.now(), state: dehydrate(saved) }),
    )
    setup(http.get('*/api/documents', () => HttpResponse.error()))

    expect(await screen.findByText('My plan')).toBeInTheDocument()
    expect(
      await screen.findByText(/You’re offline. This is what this device saved/),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Move My plan to trash' })).toBeDisabled()
    expect(screen.getByText(/^Offline/)).toBeInTheDocument()
  })

  it('renames a document inline', async () => {
    let renamedTo: unknown = null
    const { user } = setup(
      http.patch('*/api/documents/doc-mine', async ({ request }) => {
        renamedTo = await request.json()
        return HttpResponse.json({ ...mine, title: 'Better plan' })
      }),
    )
    await screen.findByText('My plan')

    await user.click(screen.getByRole('button', { name: 'Rename My plan' }))
    const input = screen.getByRole('textbox', { name: 'Document title' })
    await user.clear(input)
    await user.type(input, 'Better plan{Enter}')

    await waitFor(() => expect(renamedTo).toEqual({ title: 'Better plan' }))
  })

  it('cancels a rename with Escape', async () => {
    const { user } = setup()
    await screen.findByText('My plan')

    await user.click(screen.getByRole('button', { name: 'Rename My plan' }))
    await user.type(screen.getByRole('textbox', { name: 'Document title' }), ' changed{Escape}')

    // No PATCH handler: a request would fail the test.
    expect(screen.getByText('My plan')).toBeInTheDocument()
  })

  it('moves a document to trash and restores it from the Trash view', async () => {
    const calls: string[] = []
    const { user } = setup(
      http.delete('*/api/documents/doc-mine', () => {
        calls.push('trash')
        return new HttpResponse(null, { status: 204 })
      }),
      http.post('*/api/documents/doc-old/restore', () => {
        calls.push('restore')
        return HttpResponse.json({ ...trashed, deleted_at: null })
      }),
    )
    await screen.findByText('My plan')

    await user.click(screen.getByRole('button', { name: 'Move My plan to trash' }))
    await user.click(screen.getByRole('button', { name: 'Trash' }))
    await user.click(await screen.findByRole('button', { name: 'Restore Old draft' }))

    await waitFor(() => expect(calls).toEqual(['trash', 'restore']))
  })

  it('shows a clear message for a document the user cannot open', async () => {
    server.use(
      signedIn(),
      http.get('*/api/documents/missing', () =>
        HttpResponse.json(
          { detail: 'Document not found', code: 'document_not_found' },
          { status: 404 },
        ),
      ),
    )

    renderApp('/d/missing')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This document does not exist or you no longer have access.',
    )
  })
})

describe('dashboard search', () => {
  const hit = {
    document: mine,
    snippet: [
      { text: 'We ship the ', match: false },
      { text: 'collaborative', match: true },
      { text: ' editor in <b>October</b>.', match: false },
    ],
  }

  function searchEndpoint(seen: string[], hits = [hit]) {
    return http.get('*/api/documents/search', ({ request }) => {
      seen.push(new URL(request.url).searchParams.get('q') ?? '')
      return HttpResponse.json(hits)
    })
  }

  it('searches once typing pauses and highlights the matched words', async () => {
    const seen: string[] = []
    const { user, router } = setup(searchEndpoint(seen))
    await screen.findByText('My plan')

    await user.type(screen.getByRole('searchbox', { name: 'Search documents' }), '  collab ')

    const results = await screen.findByRole('list', { name: 'Search results' })
    expect(within(results).getByRole('link', { name: 'My plan' })).toHaveAttribute(
      'href',
      '/d/doc-mine',
    )
    expect(within(results).getByText('collaborative').tagName).toBe('MARK')
    // A document's own text is shown as text, never interpreted as HTML.
    expect(within(results).getByText(/editor in <b>October<\/b>\./)).toBeInTheDocument()
    expect(seen).toEqual(['collab']) // one request for the whole word, trimmed
    expect(router.state.location.search).toBe('?q=collab')
  })

  it('says so when nothing matches', async () => {
    const { user } = setup(searchEndpoint([], []))
    await screen.findByText('My plan')

    await user.type(screen.getByRole('searchbox', { name: 'Search documents' }), 'zebra')

    expect(await screen.findByText('No documents match “zebra”.')).toBeInTheDocument()
  })

  it('goes back to the list when the search is cleared or a filter is picked', async () => {
    const { user, router } = setup(searchEndpoint([]))
    await screen.findByText('My plan')
    const box = screen.getByRole('searchbox', { name: 'Search documents' })

    await user.type(box, 'collab')
    await screen.findByRole('list', { name: 'Search results' })
    await user.clear(box)
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Search results' })).toBeNull())
    expect(screen.getByText("Bob's notes")).toBeInTheDocument()

    await user.type(box, 'collab')
    await screen.findByRole('list', { name: 'Search results' })
    await user.click(screen.getByRole('button', { name: 'Owned by me' }))
    expect(box).toHaveValue('')
    await waitFor(() => expect(router.state.location.search).toBe('?view=owned'))
  })

  it('opens with the search from the URL', async () => {
    server.use(signedIn(), readinessOk(), documentsEndpoint(), searchEndpoint([]))
    renderApp('/?q=collab')

    expect(await screen.findByRole('list', { name: 'Search results' })).toBeInTheDocument()
    expect(screen.getByRole('searchbox', { name: 'Search documents' })).toHaveValue('collab')
  })
})
