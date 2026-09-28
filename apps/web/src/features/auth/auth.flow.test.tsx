import { screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { renderApp } from '../../test/renderApp'
import { server } from '../../test/server'
import {
  ADA,
  apiError,
  makeDocument,
  readinessOk,
  sessionFor,
  signedIn,
  signedOut,
} from '../../test/fixtures'

const dashboardHandlers = [
  readinessOk(),
  http.get('*/api/documents', () => HttpResponse.json([makeDocument()])),
]

describe('authentication flow', () => {
  it('sends signed-out visitors to the sign-in page', async () => {
    server.use(signedOut())

    renderApp('/')

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('restores a session from the refresh cookie on page load', async () => {
    server.use(signedIn(), ...dashboardHandlers)

    renderApp('/')

    expect(await screen.findByRole('heading', { name: 'Documents' })).toBeInTheDocument()
    expect(await screen.findByText('Launch plan')).toBeInTheDocument()
  })

  it('signs in and returns to the page the visitor asked for', async () => {
    let submitted: unknown = null
    server.use(
      signedOut(),
      ...dashboardHandlers,
      http.post('*/api/auth/login', async ({ request }) => {
        submitted = await request.json()
        return HttpResponse.json(sessionFor(ADA))
      }),
      http.get('*/api/documents/doc-1', () => HttpResponse.json(makeDocument())),
    )
    const { user, router } = renderApp('/d/doc-1')

    await user.type(await screen.findByLabelText('Email'), 'ada@example.com')
    await user.type(screen.getByLabelText('Password'), 'correct horse battery')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('heading', { name: 'Launch plan' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/d/doc-1')
    expect(submitted).toEqual({ email: 'ada@example.com', password: 'correct horse battery' })
  })

  it('explains wrong credentials without saying which part was wrong', async () => {
    server.use(
      signedOut(),
      http.post('*/api/auth/login', () => apiError(401, 'invalid_credentials')),
    )
    const { user } = renderApp('/login')

    await user.type(await screen.findByLabelText('Email'), 'ada@example.com')
    await user.type(screen.getByLabelText('Password'), 'nope nope nope')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect email or password.')
  })

  it('tells the visitor how long to wait when rate limited', async () => {
    server.use(
      signedOut(),
      http.post('*/api/auth/login', () =>
        apiError(429, 'rate_limited', 'Too many requests', { 'Retry-After': '42' }),
      ),
    )
    const { user } = renderApp('/login')

    await user.type(await screen.findByLabelText('Email'), 'ada@example.com')
    await user.type(screen.getByLabelText('Password'), 'guess guess')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Try again in 42 seconds.')
  })

  it('checks password length before calling the API', async () => {
    server.use(signedOut())
    const { user } = renderApp('/register')

    await user.type(await screen.findByLabelText('Name'), 'Ada')
    await user.type(screen.getByLabelText('Email'), 'ada@example.com')
    await user.type(screen.getByLabelText('Password'), 'short')
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    // No register handler exists: a request here would fail the test.
    expect(await screen.findByText('Use at least 8 characters.')).toBeInTheDocument()
  })

  it('reports an email that is already registered', async () => {
    server.use(
      signedOut(),
      http.post('*/api/auth/register', () => apiError(409, 'email_taken')),
    )
    const { user } = renderApp('/register')

    await user.type(await screen.findByLabelText('Name'), 'Ada')
    await user.type(screen.getByLabelText('Email'), 'ada@example.com')
    await user.type(screen.getByLabelText('Password'), 'long enough password')
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'An account with this email already exists.',
    )
  })

  it('signs out from the account menu', async () => {
    let loggedOut = false
    server.use(
      signedIn(),
      ...dashboardHandlers,
      http.post('*/api/auth/logout', () => {
        loggedOut = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const { user } = renderApp('/')

    await user.click(await screen.findByText(ADA.name))
    const menu = screen.getByText(ADA.email).parentElement!
    await user.click(within(menu).getByRole('button', { name: 'Sign out' }))

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(loggedOut).toBe(true)
  })
})
