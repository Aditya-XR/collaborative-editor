import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { ApiError } from '../lib/api'
import { AuthProvider } from '../features/auth/AuthProvider'
import { routes } from './routes'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Retrying a 4xx never helps (not found, forbidden); retry only network and 5xx errors.
      retry: (failures, error) =>
        failures < 2 && !(error instanceof ApiError && error.status < 500),
    },
  },
})

const router = createBrowserRouter(routes)

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  )
}
