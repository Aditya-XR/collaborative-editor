import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { ApiError } from '../lib/api'
import { AuthProvider } from '../features/auth/AuthProvider'
import { OfflineProvider } from '../features/offline/OfflineProvider'
import { routes } from './routes'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Retrying a 4xx never helps (not found, forbidden); retry only network and 5xx errors.
      retry: (failures, error) =>
        failures < 2 && !(error instanceof ApiError && error.status < 500),
    },
    // Changes always run: offline, the outbox queues the ones that can wait (ADR 0019), and the
    // rest say they need a connection. TanStack's default would hold them all, silently.
    mutations: { networkMode: 'always' },
  },
})

const router = createBrowserRouter(routes)

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <OfflineProvider>
          <RouterProvider router={router} />
        </OfflineProvider>
      </AuthProvider>
    </QueryClientProvider>
  )
}
