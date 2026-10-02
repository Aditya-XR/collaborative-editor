import { screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { encodeBase64 } from '../../lib/base64'
import { ADA, apiError, makeDocument, signedIn } from '../../test/fixtures'
import { renderApp } from '../../test/renderApp'
import { server } from '../../test/server'
import type { Role } from '../documents/api'
import { CollabProvider, type CollabDeps, type CollabState } from '../editor/CollabProvider'
import type { Version } from './api'

const live: { role: Role; provider: CollabProvider | null } = { role: 'owner', provider: null }

vi.mock('../editor/useCollab', () => ({
  useCollab: (documentId: string) => {
    live.provider ??= new CollabProvider(documentId, deps)
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

const deps: CollabDeps = {
  getTicket: async () => ({ ticket: 't', role: 'owner' }),
  socketUrl: () => 'ws://unused',
  openLocalStore: () => null,
}

/** A document as the editor stores it in Yjs: paragraphs under Tiptap's root fragment. */
function yjsState(...paragraphs: string[]): Uint8Array {
  const doc = new Y.Doc()
  doc.getXmlFragment('default').insert(
    0,
    paragraphs.map((text) => {
      const paragraph = new Y.XmlElement('paragraph')
      paragraph.insert(0, [new Y.XmlText(text)])
      return paragraph
    }),
  )
  return Y.encodeStateAsUpdate(doc)
}

const document = makeDocument()
const named: Version = {
  id: 'v-named',
  kind: 'named',
  label: 'Sent for review',
  created_at: '2026-10-01T09:30:00Z',
  created_by: { id: ADA.id, name: ADA.name },
  restored_from: null,
}
const automatic: Version = {
  id: 'v-auto',
  kind: 'auto',
  label: null,
  created_at: '2026-10-01T08:00:00Z',
  created_by: null,
  restored_from: null,
}
const beforeRestore: Version = {
  id: 'v-pre',
  kind: 'pre_restore',
  label: null,
  created_at: '2026-10-01T10:00:00Z',
  created_by: { id: ADA.id, name: ADA.name },
  restored_from: { id: named.id, label: named.label, created_at: named.created_at },
}
const states: Record<string, string> = {
  [named.id]: encodeBase64(yjsState('Old text', 'Second paragraph')),
  [automatic.id]: encodeBase64(yjsState('Earliest draft')),
  [beforeRestore.id]: encodeBase64(yjsState('Current text')),
}

function versionsEndpoints(versions: Version[]) {
  const base = `*/api/documents/${document.id}/versions`
  return [
    http.get(base, () => HttpResponse.json(versions)),
    http.get(`${base}/:versionId`, ({ params }) => {
      const version = versions.find((v) => v.id === params.versionId)
      return version
        ? HttpResponse.json({ ...version, state: states[version.id] })
        : apiError(404, 'version_not_found')
    }),
  ]
}

function openEditor(...handlers: Parameters<typeof server.use>) {
  // MSW answers with the first matching handler, so the test's own come first.
  server.use(
    ...handlers,
    signedIn(),
    http.get(`*/api/documents/${document.id}`, () =>
      HttpResponse.json({ ...document, role: live.role }),
    ),
    ...versionsEndpoints([beforeRestore, named, automatic]),
  )
  return renderApp(`/d/${document.id}`)
}

async function openHistory(user: ReturnType<typeof openEditor>['user']) {
  await user.click(await screen.findByRole('button', { name: 'History' }))
  return screen.findByRole('dialog', { name: 'Version history' })
}

beforeEach(() => {
  live.role = 'owner'
  // The live document already holds text, as if synced from the server.
  live.provider = new CollabProvider(document.id, deps)
  Y.applyUpdate(live.provider.doc, yjsState('Current text'))
})

describe('version history', () => {
  it('is offered to editors but not to viewers', async () => {
    live.role = 'viewer'
    openEditor()

    await screen.findByRole('textbox', { name: 'Document body' })
    expect(screen.queryByRole('button', { name: 'History' })).toBeNull()
  })

  it('lists versions and previews one exactly as it was', async () => {
    const { user } = openEditor()
    const dialog = await openHistory(user)

    const list = within(dialog).getByRole('region', { name: 'Versions' })
    expect(
      within(list)
        .getAllByRole('button')
        .map((button) => button.firstChild?.textContent),
    ).toEqual(['Before restoring “Sent for review”', 'Sent for review', 'Automatic version'])

    await user.click(within(list).getByRole('button', { name: /^Sent for review/ }))
    const preview = await within(dialog).findByRole('textbox', { name: 'Version preview' })
    await waitFor(() => expect(preview).toHaveTextContent('Old textSecond paragraph'))
    expect(preview).toHaveAttribute('contenteditable', 'false')
  })

  it('saves the current version under a name', async () => {
    let saved: unknown = null
    const created: Version = { ...named, id: 'v-new', label: 'Final' }
    const versions = [named]
    const { user } = openEditor(
      ...versionsEndpoints(versions),
      http.post(`*/api/documents/${document.id}/versions`, async ({ request }) => {
        saved = await request.json()
        versions.unshift(created)
        states[created.id] = states[named.id]
        return HttpResponse.json(created, { status: 201 })
      }),
    )
    const dialog = await openHistory(user)

    await user.type(
      within(dialog).getByRole('textbox', { name: 'Name for the current version' }),
      'Final',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Save version' }))

    await waitFor(() => expect(saved).toEqual({ label: 'Final' }))
    const selected = await within(dialog).findByRole('button', { current: true })
    expect(selected).toHaveTextContent('Final')
  })

  it('restores a version for everyone as an edit that Undo reverts', async () => {
    const calls: string[] = []
    const { user } = openEditor(
      http.post(`*/api/documents/${document.id}/versions/${named.id}/restore`, () => {
        calls.push('prepare')
        return HttpResponse.json(beforeRestore, { status: 201 })
      }),
    )
    const body = await screen.findByRole('textbox', { name: 'Document body' })
    await waitFor(() => expect(body).toHaveTextContent('Current text'))
    const dialog = await openHistory(user)

    await user.click(within(dialog).getByRole('button', { name: /^Sent for review/ }))
    await within(dialog).findByRole('textbox', { name: 'Version preview' })
    await user.click(within(dialog).getByRole('button', { name: 'Restore this version' }))
    await user.click(within(dialog).getByRole('button', { name: 'Restore' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(calls).toEqual(['prepare'])
    expect(body).toHaveTextContent('Old textSecond paragraph')
    // The change went into the shared Yjs document, so it syncs like any other edit.
    expect(live.provider!.doc.getXmlFragment('default').toString()).toContain('Old text')
    expect(screen.getByText(/^Restored Sent for review\./)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(body).toHaveTextContent('Current text'))
    expect(body).not.toHaveTextContent('Old text')
  })

  it('leaves the document alone when the restore cannot be prepared', async () => {
    const { user } = openEditor(
      http.post(`*/api/documents/${document.id}/versions/${named.id}/restore`, () =>
        apiError(500, 'internal_error'),
      ),
    )
    const body = await screen.findByRole('textbox', { name: 'Document body' })
    const dialog = await openHistory(user)

    await user.click(within(dialog).getByRole('button', { name: /^Sent for review/ }))
    await within(dialog).findByRole('textbox', { name: 'Version preview' })
    await user.click(within(dialog).getByRole('button', { name: 'Restore this version' }))
    await user.click(within(dialog).getByRole('button', { name: 'Restore' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Something went wrong on our side',
    )
    expect(body).toHaveTextContent('Current text')
    expect(body).not.toHaveTextContent('Old text')
  })

  it('names an automatic version', async () => {
    let renamed: unknown = null
    const { user } = openEditor(
      http.patch(`*/api/documents/${document.id}/versions/${automatic.id}`, async ({ request }) => {
        renamed = await request.json()
        return HttpResponse.json({ ...automatic, kind: 'named', label: 'First draft' })
      }),
    )
    const dialog = await openHistory(user)

    await user.click(within(dialog).getByRole('button', { name: /Automatic version/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Name this version' }))
    await user.type(within(dialog).getByRole('textbox', { name: 'Version name' }), 'First draft')
    await user.click(within(dialog).getByRole('button', { name: 'Save name' }))

    await waitFor(() => expect(renamed).toEqual({ label: 'First draft' }))
  })
})
