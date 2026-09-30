import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { ADA, apiError, makeDocument, sessionFor, signedIn, signedOut } from '../../test/fixtures'
import { renderApp } from '../../test/renderApp'
import { server } from '../../test/server'
import { CollabProvider } from '../editor/CollabProvider'

// Once accepted, the page opens the editor; its live connection is not under test here.
vi.mock('../editor/useCollab', () => ({
  useCollab: (documentId: string) => ({
    provider: new CollabProvider(documentId, {
      getTicket: async () => ({ ticket: 't', role: 'editor' }),
      socketUrl: () => 'ws://unused',
      openLocalStore: () => null,
    }),
    state: {
      status: 'online',
      synced: true,
      localReady: true,
      unsynced: 0,
      role: 'editor',
      stopReason: null,
      peers: [],
    },
  }),
}))

const shared = makeDocument({ id: 'doc-9', title: 'Shared with you', role: 'editor' })

function acceptEndpoint(response: () => Response) {
  const tokens: unknown[] = []
  server.use(
    http.post('*/api/links/accept', async ({ request }) => {
      tokens.push(await request.json())
      return response()
    }),
    http.get('*/api/documents/doc-9', () => HttpResponse.json(shared)),
  )
  return tokens
}

describe('accepting a share link', () => {
  it('adds the visitor and opens the document', async () => {
    server.use(signedIn())
    const tokens = acceptEndpoint(() => HttpResponse.json({ document_id: 'doc-9', role: 'editor' }))
    const { router } = renderApp('/share/abcdefghijklmnop1234')

    expect(await screen.findByRole('heading', { name: 'Shared with you' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/d/doc-9')
    expect(tokens).toEqual([{ token: 'abcdefghijklmnop1234' }]) // sent in the body, once
  })

  it('explains an expired link', async () => {
    server.use(signedIn())
    acceptEndpoint(() => apiError(410, 'link_expired'))

    renderApp('/share/abcdefghijklmnop1234')

    expect(await screen.findByRole('alert')).toHaveTextContent('This link has expired')
  })

  it('sends signed-out visitors to sign in, then back to the link', async () => {
    server.use(
      signedOut(),
      http.post('*/api/auth/login', () => HttpResponse.json(sessionFor(ADA))),
    )
    const tokens = acceptEndpoint(() => HttpResponse.json({ document_id: 'doc-9', role: 'editor' }))
    const { user, router } = renderApp('/share/abcdefghijklmnop1234')

    await user.type(await screen.findByLabelText('Email'), ADA.email)
    await user.type(screen.getByLabelText('Password'), 'correct horse battery')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/d/doc-9'))
    expect(tokens).toHaveLength(1)
  })
})
