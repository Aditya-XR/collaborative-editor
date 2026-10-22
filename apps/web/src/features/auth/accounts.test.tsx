import { screen, waitFor, within } from '@testing-library/react'
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

const unverified = { ...ADA, email_verified: false }
const googleOn = () => http.get('*/api/auth/options', () => HttpResponse.json({ google: true }))
const dashboardHandlers = [
  readinessOk(),
  http.get('*/api/documents', () => HttpResponse.json([makeDocument()])),
]

describe('sign in with Google', () => {
  it('offers Google when it is set up, returning to the page asked for', async () => {
    server.use(signedOut(), googleOn())
    renderApp('/d/doc-1')

    const link = await screen.findByRole('link', { name: 'Continue with Google' })
    expect(link.getAttribute('href')).toMatch(/\/api\/auth\/google\/start\?next=%2Fd%2Fdoc-1$/)
  })

  it('stays hidden when the server has no Google sign-in', async () => {
    server.use(signedOut())
    renderApp('/login')

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    // Let the options request answer before checking.
    await waitFor(() => expect(screen.queryByText('Checking')).toBeNull())
    expect(screen.queryByRole('link', { name: 'Continue with Google' })).toBeNull()
  })

  it('says why a Google sign-in came back', async () => {
    server.use(signedOut(), googleOn())
    renderApp('/login?error=google_email_unverified')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Google has not verified that email address',
    )
  })
})

describe('password reset', () => {
  it('emails a link to the address typed on the sign-in page', async () => {
    let asked: unknown = null
    server.use(
      signedOut(),
      http.post('*/api/auth/password/forgot', async ({ request }) => {
        asked = await request.json()
        return HttpResponse.json(
          { detail: 'If an account uses that address, a link is on its way.' },
          { status: 202 },
        )
      }),
    )
    const { user } = renderApp('/login')

    await user.type(await screen.findByLabelText('Email'), 'ada@example.com')
    await user.click(screen.getByRole('link', { name: 'Forgot password?' }))
    expect(await screen.findByLabelText('Email')).toHaveValue('ada@example.com')
    await user.click(screen.getByRole('button', { name: 'Email me a link' }))

    expect(await screen.findByRole('status')).toHaveTextContent('a link is on its way')
    expect(asked).toEqual({ email: 'ada@example.com' })
  })

  it('sets a new password from the emailed link, then asks to sign in again', async () => {
    let sent: unknown = null
    server.use(
      signedOut(),
      http.post('*/api/auth/password/reset', async ({ request }) => {
        sent = await request.json()
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const { user, router } = renderApp('/reset-password#token=tok-123')

    await user.type(await screen.findByLabelText('New password'), 'a brand new one')
    await user.click(screen.getByRole('button', { name: 'Set new password' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
    expect(sent).toEqual({ token: 'tok-123', password: 'a brand new one' })
    expect(await screen.findByRole('status')).toHaveTextContent('Your password is changed')
  })

  it('offers a new link when the old one has expired', async () => {
    server.use(
      signedOut(),
      http.post('*/api/auth/password/reset', () =>
        apiError(400, 'token_expired', 'This link has expired. Ask for a new one.'),
      ),
    )
    const { user } = renderApp('/reset-password#token=old')

    await user.type(await screen.findByLabelText('New password'), 'a brand new one')
    await user.click(screen.getByRole('button', { name: 'Set new password' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('This link has expired')
    expect(within(alert).getByRole('link', { name: 'Get a new link' })).toHaveAttribute(
      'href',
      '/forgot-password',
    )
  })

  it('checks the password length before sending', async () => {
    server.use(signedOut())
    const { user } = renderApp('/reset-password#token=tok')

    await user.type(await screen.findByLabelText('New password'), 'short')
    await user.click(screen.getByRole('button', { name: 'Set new password' }))

    expect(screen.getByText('Use at least 8 characters.')).toBeInTheDocument()
  })
})

describe('email verification', () => {
  it('asks unverified people to confirm their address, and resends the link', async () => {
    let resent = false
    server.use(
      signedIn(unverified),
      ...dashboardHandlers,
      http.post('*/api/auth/email/resend', () => {
        resent = true
        return HttpResponse.json(
          { detail: 'A new link is on its way to ada@example.com.' },
          { status: 202 },
        )
      }),
    )
    const { user } = renderApp('/')

    const banner = await screen.findByRole('region', { name: 'Confirm your email' })
    expect(banner).toHaveTextContent('Confirm ada@example.com')
    await user.click(within(banner).getByRole('button', { name: 'Send it again' }))

    expect(await within(banner).findByText(/A new link is on its way/)).toBeInTheDocument()
    expect(resent).toBe(true)
  })

  it('confirms the address from the emailed link and drops the banner', async () => {
    let token: unknown = null
    server.use(
      signedIn(unverified),
      ...dashboardHandlers,
      http.post('*/api/auth/email/verify', async ({ request }) => {
        token = ((await request.json()) as { token: string }).token
        return HttpResponse.json(ADA)
      }),
    )
    const { user } = renderApp('/verify-email#token=verify-me')

    expect(await screen.findByRole('status')).toHaveTextContent('Your email address is confirmed')
    expect(token).toBe('verify-me')
    await user.click(screen.getByRole('link', { name: 'Go to your documents' }))
    await screen.findByRole('heading', { name: 'Documents' })
    expect(screen.queryByRole('region', { name: 'Confirm your email' })).toBeNull()
  })

  it('explains a link that no longer works', async () => {
    server.use(
      signedOut(),
      http.post('*/api/auth/email/verify', () =>
        apiError(400, 'invalid_token', 'This link is not valid, or it was already used.'),
      ),
    )
    renderApp('/verify-email#token=stale')

    expect(await screen.findByRole('alert')).toHaveTextContent('This link is not valid')
  })

  it('shows nothing to people who are verified', async () => {
    server.use(
      http.post('*/api/auth/refresh', () => HttpResponse.json(sessionFor(ADA))),
      ...dashboardHandlers,
    )
    renderApp('/')

    await screen.findByRole('heading', { name: 'Documents' })
    expect(screen.queryByRole('region', { name: 'Confirm your email' })).toBeNull()
  })
})

describe('privacy policy', () => {
  it('opens signed out and is linked from the sign-in page', async () => {
    server.use(signedOut())
    renderApp('/login')

    const link = await screen.findByRole('link', { name: 'Privacy policy' })
    expect(link).toHaveAttribute('href', '/privacy')
  })

  it('is not sent to sign-in first', async () => {
    server.use(signedOut())
    renderApp('/privacy')

    expect(await screen.findByRole('heading', { name: 'Privacy policy' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull()
  })
})
