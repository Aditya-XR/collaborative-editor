import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ADA, BOB, makeDocument, signedIn } from '../../test/fixtures'
import { renderApp } from '../../test/renderApp'
import { server } from '../../test/server'
import type { CollabDeps, CollabState } from './CollabProvider'
import { CollabProvider } from './CollabProvider'

// The page's live connection is replaced by a provider whose state each test controls.
const live: { state: CollabState } = { state: baseState() }

vi.mock('./useCollab', () => ({
  useCollab: (documentId: string) => {
    const deps: CollabDeps = {
      getTicket: async () => ({ ticket: 't', role: 'editor' }),
      socketUrl: () => 'ws://unused',
      openLocalStore: () => null,
    }
    return { provider: new CollabProvider(documentId, deps), state: live.state }
  },
}))

function baseState(overrides: Partial<CollabState> = {}): CollabState {
  return {
    status: 'online',
    synced: true,
    localReady: true,
    unsynced: 0,
    role: 'owner',
    stopReason: null,
    peers: [
      { clientId: 1, name: ADA.name, color: '#e11d48', self: true },
      { clientId: 2, name: 'Grace Hopper', color: '#2563eb', self: false },
    ],
    ...overrides,
  }
}

function openDocument(document = makeDocument()) {
  server.use(
    signedIn(),
    http.get(`*/api/documents/${document.id}`, () => HttpResponse.json(document)),
  )
  return renderApp(`/d/${document.id}`)
}

beforeEach(() => {
  live.state = baseState()
})

describe('editor page', () => {
  it('shows an editable document with its collaborators and sync state', async () => {
    openDocument()

    const body = await screen.findByRole('textbox', { name: 'Document body' })
    expect(body).toHaveAttribute('contenteditable', 'true')
    expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument()
    expect(screen.getByText('All changes synced')).toBeInTheDocument()
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument()
    expect(screen.getByText(`${ADA.name} (you)`)).toBeInTheDocument()
  })

  it('makes the document read-only for viewers', async () => {
    live.state = baseState({ role: 'viewer' })
    openDocument(makeDocument({ role: 'viewer', owner: { id: BOB.id, name: BOB.name } }))

    const body = await screen.findByRole('textbox', { name: 'Document body' })
    expect(body).toHaveAttribute('contenteditable', 'false')
    expect(screen.queryByRole('toolbar')).toBeNull()
    expect(screen.getByText(/You have view access/)).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Document title' })).toBeNull()
  })

  it('tells the writer their offline edits are safe on this device', async () => {
    live.state = baseState({ status: 'offline', synced: false, unsynced: 3 })
    openDocument()

    expect(await screen.findByText('Offline · 3 changes saved on this device')).toBeInTheDocument()
  })

  it('explains why editing stopped when the document was trashed', async () => {
    live.state = baseState({ status: 'stopped', stopReason: 'not_found' })
    openDocument()

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This document was moved to trash or deleted.',
    )
    expect(screen.queryByRole('textbox', { name: 'Document body' })).toBeNull()
  })

  it('renames the document from the title field', async () => {
    let renamed: unknown = null
    const document = makeDocument()
    server.use(
      http.patch(`*/api/documents/${document.id}`, async ({ request }) => {
        renamed = await request.json()
        return HttpResponse.json({ ...document, title: 'Q4 plan' })
      }),
    )
    const { user } = openDocument(document)

    const title = await screen.findByRole('textbox', { name: 'Document title' })
    await user.clear(title)
    await user.type(title, 'Q4 plan{Enter}')

    await waitFor(() => expect(renamed).toEqual({ title: 'Q4 plan' }))
  })
})
