import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { setTokenSource } from '../../lib/api'
import { authApi } from './api'
import { AuthContext, type AuthValue } from './context'
import { session as defaultSession, type SessionManager } from './session'

export function AuthProvider({
  children,
  manager = defaultSession,
}: {
  children: ReactNode
  manager?: SessionManager
}) {
  // Registered during render, before any child can issue an authenticated request.
  useState(() => setTokenSource(manager))
  const queryClient = useQueryClient()
  const user = useSyncExternalStore(manager.subscribe, manager.getSnapshot)
  const [status, setStatus] = useState<AuthValue['status']>('loading')

  useEffect(() => {
    let active = true
    // The httpOnly refresh cookie survives reloads; trade it for an access token.
    manager
      .refreshAccessToken()
      .catch(() => null)
      .finally(() => {
        if (active) setStatus('ready')
      })
    return () => {
      active = false
    }
  }, [manager])

  const value = useMemo<AuthValue>(
    () => ({
      user,
      status,
      signIn: async (credentials) => manager.start(await authApi.login(credentials)),
      signUp: async (registration) => manager.start(await authApi.register(registration)),
      signOut: async () => {
        try {
          await authApi.logout()
        } finally {
          manager.signOut()
          queryClient.clear()
        }
      },
      signOutEverywhere: async () => {
        await authApi.logoutAll()
        manager.signOut()
        queryClient.clear()
      },
    }),
    [manager, queryClient, status, user],
  )

  return <AuthContext value={value}>{children}</AuthContext>
}
