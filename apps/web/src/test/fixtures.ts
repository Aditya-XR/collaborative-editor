import { http, HttpResponse } from 'msw'
import type { DocumentSummary } from '../features/documents/api'
import type { SessionResponse, User } from '../features/auth/session'

export const ADA: User = { id: 'u-ada', email: 'ada@example.com', name: 'Ada Lovelace' }
export const BOB: User = { id: 'u-bob', email: 'bob@example.com', name: 'Bob' }

export function sessionFor(user: User, token = `token-${user.id}`): SessionResponse {
  return { access_token: token, token_type: 'bearer', expires_in: 900, user }
}

export function apiError(status: number, code: string, detail = code, headers = {}) {
  return HttpResponse.json({ detail, code }, { status, headers })
}

export function makeDocument(overrides: Partial<DocumentSummary> = {}): DocumentSummary {
  const now = new Date().toISOString()
  return {
    id: 'doc-1',
    title: 'Launch plan',
    role: 'owner',
    owner: { id: ADA.id, name: ADA.name },
    created_at: now,
    updated_at: now,
    deleted_at: null,
    ...overrides,
  }
}

/** The boot-time silent refresh: a returning visitor with a valid cookie. */
export const signedIn = (user: User = ADA) =>
  http.post('*/api/auth/refresh', () => HttpResponse.json(sessionFor(user)))

/** The boot-time silent refresh: no session cookie. */
export const signedOut = () =>
  http.post('*/api/auth/refresh', () => apiError(401, 'no_session', 'Not signed in'))

export const readinessOk = () =>
  http.get('*/api/readyz', () =>
    HttpResponse.json({
      status: 'ok',
      checks: { database: { status: 'ok', detail: null }, redis: { status: 'ok', detail: null } },
    }),
  )
