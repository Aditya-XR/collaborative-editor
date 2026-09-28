import { Navigate, Outlet, useLocation } from 'react-router'
import { FullPageSpinner } from '../../components/ui/Spinner'
import { useAuth } from './useAuth'

export function RequireAuth() {
  const { user, status } = useAuth()
  const location = useLocation()

  if (status === 'loading') return <FullPageSpinner label="Restoring your session" />
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  return <Outlet />
}

export function RedirectIfSignedIn() {
  const { user, status } = useAuth()

  if (status === 'loading') return <FullPageSpinner label="Restoring your session" />
  if (user) return <Navigate to="/" replace />
  return <Outlet />
}
