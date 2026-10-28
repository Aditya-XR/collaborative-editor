import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { onTestFinished } from 'vitest'
import { routes } from '../app/routes'
import { AuthProvider } from '../features/auth/AuthProvider'
import { OfflineProvider } from '../features/offline/OfflineProvider'
import { SessionManager } from '../features/auth/session'

/** Renders the real route tree at `path`, with a fresh cache and session per test. */
export function renderApp(path: string) {
  // As the app's own client: changes run offline too, and the outbox decides what waits.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { networkMode: 'always' } },
  })
  const manager = new SessionManager()
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  onTestFinished(() => manager.dispose())

  const view = render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider manager={manager}>
        <OfflineProvider>
          <RouterProvider router={router} />
        </OfflineProvider>
      </AuthProvider>
    </QueryClientProvider>,
  )
  return { ...view, router, manager, user: userEvent.setup() }
}
