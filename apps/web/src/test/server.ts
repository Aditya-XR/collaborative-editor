import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'

/**
 * Intercepts fetch at the network layer; each test registers the endpoints it expects. Every
 * editor loads its comments, so pages without comments get an empty list unless a test says
 * otherwise.
 */
export const server = setupServer(
  http.get('*/api/documents/:documentId/threads', () => HttpResponse.json([])),
  // The sign-in pages ask which ways to sign in exist; Google is off unless a test says so.
  http.get('*/api/auth/options', () => HttpResponse.json({ google: false })),
)
