import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { server } from '../test/server'
import { apiError } from '../test/fixtures'
import { api, ApiError, setTokenSource } from './api'
import { describeError } from './errors'

function tokenSource(current: string, refreshed: string | null) {
  const source = {
    getAccessToken: vi.fn(() => current),
    refreshAccessToken: vi.fn(async () => refreshed),
  }
  setTokenSource(source)
  return source
}

describe('api', () => {
  it('refreshes an expired access token once and retries the request', async () => {
    server.use(
      http.get('*/api/me', ({ request }) =>
        request.headers.get('Authorization') === 'Bearer new'
          ? HttpResponse.json({ id: 'u1' })
          : apiError(401, 'token_expired'),
      ),
    )
    const source = tokenSource('old', 'new')

    await expect(api('/me')).resolves.toEqual({ id: 'u1' })
    expect(source.refreshAccessToken).toHaveBeenCalledOnce()
  })

  it('does not refresh for other 401 errors', async () => {
    server.use(http.get('*/api/me', () => apiError(401, 'invalid_token')))
    const source = tokenSource('forged', 'new')

    await expect(api('/me')).rejects.toMatchObject({ status: 401, code: 'invalid_token' })
    expect(source.refreshAccessToken).not.toHaveBeenCalled()
  })

  it('sends JSON bodies and cookies', async () => {
    let seen: { contentType: string | null; body: unknown } | null = null
    server.use(
      http.post('*/api/documents', async ({ request }) => {
        seen = { contentType: request.headers.get('Content-Type'), body: await request.json() }
        return HttpResponse.json({ id: 'd1' }, { status: 201 })
      }),
    )

    await api('/documents', { method: 'POST', body: { title: 'Plan' }, auth: false })

    expect(seen).toEqual({ contentType: 'application/json', body: { title: 'Plan' } })
  })

  it('turns error responses into ApiError with code and Retry-After', async () => {
    server.use(
      http.post('*/api/auth/login', () =>
        apiError(429, 'rate_limited', 'Too many requests', { 'Retry-After': '30' }),
      ),
    )

    const error = await api('/auth/login', { method: 'POST', auth: false }).catch((e) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 429, code: 'rate_limited', retryAfterSeconds: 30 })
    expect(describeError(error)).toBe('Too many attempts. Try again in 30 seconds.')
  })

  it('explains validation errors by field', async () => {
    server.use(
      http.post('*/api/auth/register', () =>
        HttpResponse.json(
          {
            code: 'validation_error',
            detail: [
              {
                loc: ['body', 'email'],
                msg: 'value is not a valid email address: reserved name',
                ctx: { reason: 'The part after the @-sign is a reserved name.' },
              },
            ],
          },
          { status: 422 },
        ),
      ),
    )

    const error = await api('/auth/register', { method: 'POST', auth: false }).catch((e) => e)

    expect(error).toMatchObject({ status: 422, code: 'validation_error' })
    expect(describeError(error)).toBe('Email: The part after the @-sign is a reserved name.')
  })

  it.each([
    [1, '1 second'],
    [42, '42 seconds'],
    [61, '2 minutes'],
    [1046, '18 minutes'],
    [3600, '1 hour'],
  ])('rounds a %i second wait up to "%s"', (seconds, text) => {
    const error = new ApiError(429, 'rate_limited', 'Too many requests', seconds)

    expect(describeError(error)).toBe(`Too many attempts. Try again in ${text}.`)
  })

  it('returns undefined for 204 responses', async () => {
    server.use(http.delete('*/api/documents/d1', () => new HttpResponse(null, { status: 204 })))

    await expect(api('/documents/d1', { method: 'DELETE', auth: false })).resolves.toBeUndefined()
  })
})
