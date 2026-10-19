import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { Alert } from '../../components/ui/Alert'
import { Spinner } from '../../components/ui/Spinner'
import { describeError } from '../../lib/errors'
import { authApi, tokenFromHash } from './api'
import { AuthLayout } from './AuthLayout'
import { useAuth } from './useAuth'

type Outcome = { state: 'checking' } | { state: 'done' } | { state: 'failed'; message: string }

/** Opened from the link in a verification email: /verify-email#token=… Works signed out too. */
export function VerifyEmailPage() {
  const token = tokenFromHash(useLocation().hash)
  const { user, updateUser } = useAuth()
  const [outcome, setOutcome] = useState<Outcome>(
    token ? { state: 'checking' } : { state: 'failed', message: 'This link is incomplete.' },
  )
  const sent = useRef(false)

  useEffect(() => {
    // Once, even when React runs effects twice in development: the server accepts a repeat,
    // but there is no reason to ask twice.
    if (!token || sent.current) return
    sent.current = true
    authApi.verifyEmail(token).then(
      (verified) => {
        updateUser(verified)
        setOutcome({ state: 'done' })
      },
      (caught: unknown) => setOutcome({ state: 'failed', message: describeError(caught) }),
    )
  }, [token, updateUser])

  return (
    <AuthLayout
      title="Confirm your email"
      subtitle="So we can send you comment notifications and password resets."
      footer={
        <Link
          to={user ? '/' : '/login'}
          className="font-medium text-indigo-600 dark:text-indigo-400"
        >
          {user ? 'Go to your documents' : 'Sign in'}
        </Link>
      }
    >
      {outcome.state === 'checking' && (
        <div className="flex justify-center py-4 text-indigo-600">
          <Spinner />
        </div>
      )}
      {outcome.state === 'done' && (
        <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">
          Your email address is confirmed.
        </p>
      )}
      {outcome.state === 'failed' && (
        <Alert>
          {outcome.message}{' '}
          {user ? 'Ask for a new link from the banner at the top of your documents.' : ''}
        </Alert>
      )}
    </AuthLayout>
  )
}
