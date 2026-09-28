import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '../../test/server'
import { readinessOk } from '../../test/fixtures'
import { ApiStatus } from './ApiStatus'

function renderStatus() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ApiStatus />
    </QueryClientProvider>,
  )
}

describe('ApiStatus', () => {
  it('reports ready when every dependency is ok', async () => {
    server.use(readinessOk())

    renderStatus()

    expect(await screen.findByText('API ready')).toBeInTheDocument()
  })

  it('names the failing dependency when readiness returns 503', async () => {
    server.use(
      http.get('*/api/readyz', () =>
        HttpResponse.json(
          {
            status: 'error',
            checks: {
              database: { status: 'ok', detail: null },
              redis: { status: 'error', detail: 'ConnectionError' },
            },
          },
          { status: 503 },
        ),
      ),
    )

    renderStatus()

    expect(await screen.findByText('API degraded: redis unavailable')).toBeInTheDocument()
  })

  it('reports unreachable when the request fails', async () => {
    server.use(http.get('*/api/readyz', () => HttpResponse.error()))

    renderStatus()

    expect(await screen.findByText('API unreachable')).toBeInTheDocument()
  })

  it('reports unreachable when the proxy answers 502', async () => {
    server.use(http.get('*/api/readyz', () => new HttpResponse('Bad gateway', { status: 502 })))

    renderStatus()

    expect(await screen.findByText('API unreachable')).toBeInTheDocument()
  })
})
