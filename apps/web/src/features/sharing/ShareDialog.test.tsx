import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { ADA, BOB, apiError, makeDocument } from '../../test/fixtures'
import { server } from '../../test/server'
import type { User } from '../auth/session'
import type { Role } from '../documents/api'
import type { Member } from './api'
import { ShareDialog } from './ShareDialog'

const DOC = makeDocument({ id: 'doc-1', title: 'Team plan' })
const CAROL: User = { id: 'u-carol', email: 'carol@example.com', name: 'Carol' }

function member(user: User, role: Role): Member {
  return { user, role, added_at: new Date().toISOString() }
}

/** A members endpoint backed by a mutable list, so mutations show up on refetch. */
function membersApi(initial: Member[]) {
  const state = { members: initial }
  server.use(http.get('*/api/documents/doc-1/members', () => HttpResponse.json(state.members)))
  return state
}

function renderDialog(currentUser: User, role: Role) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onClose = vi.fn()
  const router = createMemoryRouter(
    [
      {
        path: '/d/doc-1',
        element: (
          <ShareDialog document={DOC} currentUser={currentUser} role={role} onClose={onClose} />
        ),
      },
      { path: '/', element: <p>Dashboard</p> },
    ],
    { initialEntries: ['/d/doc-1'] },
  )
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { user: userEvent.setup(), onClose, router }
}

describe('ShareDialog', () => {
  it('lets the owner invite someone by email', async () => {
    const state = membersApi([member(ADA, 'owner')])
    server.use(http.get('*/api/documents/doc-1/links', () => HttpResponse.json([])))
    let invited: unknown = null
    server.use(
      http.post('*/api/documents/doc-1/members', async ({ request }) => {
        invited = await request.json()
        const added = member(BOB, 'commenter')
        state.members = [...state.members, added]
        return HttpResponse.json(added, { status: 201 })
      }),
    )
    const { user } = renderDialog(ADA, 'owner')

    await user.type(await screen.findByLabelText('Email to invite'), 'bob@example.com')
    await user.selectOptions(screen.getByLabelText('Role for the invite'), 'commenter')
    await user.click(screen.getByRole('button', { name: 'Invite' }))

    await waitFor(() => expect(invited).toEqual({ email: 'bob@example.com', role: 'commenter' }))
    expect(await screen.findByText(BOB.email)).toBeInTheDocument()
    expect(screen.getByLabelText('Email to invite')).toHaveValue('')
  })

  it('explains when nobody has that email', async () => {
    membersApi([member(ADA, 'owner')])
    server.use(
      http.get('*/api/documents/doc-1/links', () => HttpResponse.json([])),
      http.post('*/api/documents/doc-1/members', () =>
        apiError(
          404,
          'user_not_found',
          'No account uses that email. Share a link with them instead.',
        ),
      ),
    )
    const { user } = renderDialog(ADA, 'owner')

    await user.type(await screen.findByLabelText('Email to invite'), 'ghost@example.com')
    await user.click(screen.getByRole('button', { name: 'Invite' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Share a link with them instead')
  })

  it('lets the owner change roles and remove people', async () => {
    const state = membersApi([member(ADA, 'owner'), member(BOB, 'viewer')])
    const calls: string[] = []
    server.use(
      http.get('*/api/documents/doc-1/links', () => HttpResponse.json([])),
      http.patch('*/api/documents/doc-1/members/u-bob', async ({ request }) => {
        calls.push(`role:${((await request.json()) as { role: string }).role}`)
        state.members = [member(ADA, 'owner'), member(BOB, 'editor')]
        return new HttpResponse(null, { status: 204 })
      }),
      http.delete('*/api/documents/doc-1/members/u-bob', () => {
        calls.push('remove')
        state.members = [member(ADA, 'owner')]
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const { user } = renderDialog(ADA, 'owner')

    await user.selectOptions(await screen.findByLabelText('Role for Bob'), 'editor')
    await waitFor(() => expect(screen.getByLabelText('Role for Bob')).toHaveValue('editor'))
    await user.click(screen.getByRole('button', { name: 'Remove Bob' }))

    await waitFor(() => expect(screen.queryByText(BOB.email)).toBeNull())
    expect(calls).toEqual(['role:editor', 'remove'])
  })

  it('asks for confirmation before transferring ownership', async () => {
    membersApi([member(ADA, 'owner'), member(BOB, 'editor')])
    let transferredTo: unknown = null
    server.use(
      http.get('*/api/documents/doc-1/links', () => HttpResponse.json([])),
      http.post('*/api/documents/doc-1/transfer-ownership', async ({ request }) => {
        transferredTo = await request.json()
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const { user } = renderDialog(ADA, 'owner')

    await user.click(await screen.findByRole('button', { name: 'Make Bob the owner' }))
    expect(screen.getByText(/You will become an editor/)).toBeInTheDocument()
    expect(transferredTo).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Transfer' }))

    await waitFor(() => expect(transferredTo).toEqual({ user_id: 'u-bob' }))
  })

  it('shows viewers who has access but no controls, and lets them leave', async () => {
    membersApi([member(BOB, 'owner'), member(ADA, 'viewer'), member(CAROL, 'editor')])
    let left = false
    server.use(
      http.delete('*/api/documents/doc-1/members/u-ada', () => {
        left = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const { user, router } = renderDialog(ADA, 'viewer')

    await screen.findByText(BOB.email) // members have loaded
    const list = within(screen.getByRole('list'))
    expect(list.getByText('Owner')).toBeInTheDocument()
    expect(screen.queryByLabelText('Email to invite')).toBeNull()
    expect(screen.queryByText('Share links')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Leave' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    expect(left).toBe(true)
  })

  it('creates a link, shows it once, copies it and can turn links off', async () => {
    membersApi([member(ADA, 'owner')])
    const active = { links: [] as object[] }
    let revoked = false
    server.use(
      http.get('*/api/documents/doc-1/links', () => HttpResponse.json(active.links)),
      http.post('*/api/documents/doc-1/links', async ({ request }) => {
        expect(await request.json()).toEqual({ role: 'editor', expires_in_days: 30 })
        const link = {
          id: 'l1',
          role: 'editor',
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 30 * 864e5).toISOString(),
        }
        active.links = [link]
        return HttpResponse.json({ ...link, token: 'secret-token-123' }, { status: 201 })
      }),
      http.delete('*/api/documents/doc-1/links/l1', () => {
        revoked = true
        active.links = []
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const { user } = renderDialog(ADA, 'owner')

    await user.selectOptions(await screen.findByLabelText('Role for the link'), 'editor')
    await user.selectOptions(screen.getByLabelText('Link expires after'), '30')
    await user.click(screen.getByRole('button', { name: 'Create link' }))

    const url = await screen.findByLabelText('New share link')
    expect(url).toHaveValue(`${location.origin}/share/secret-token-123`)
    await user.click(screen.getByRole('button', { name: 'Copy' }))
    // user-event installs a clipboard stub; read back what the page wrote to it.
    expect(await navigator.clipboard.readText()).toBe(`${location.origin}/share/secret-token-123`)
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()

    await user.click(await screen.findByRole('button', { name: 'Turn off editor link' }))
    await waitFor(() => expect(revoked).toBe(true))
  })

  it('closes on Escape', async () => {
    membersApi([member(ADA, 'owner')])
    server.use(http.get('*/api/documents/doc-1/links', () => HttpResponse.json([])))
    const { user, onClose } = renderDialog(ADA, 'owner')

    await screen.findByText(ADA.email)
    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalled()
  })
})
