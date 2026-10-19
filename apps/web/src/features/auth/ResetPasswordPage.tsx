import { useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { TextField } from '../../components/ui/TextField'
import { ApiError } from '../../lib/api'
import { describeError } from '../../lib/errors'
import { authApi, tokenFromHash } from './api'
import { AuthLayout } from './AuthLayout'
import { useAuth } from './useAuth'

const MIN_PASSWORD = 8

/** Opened from the link in a reset email: /reset-password#token=… */
export function ResetPasswordPage() {
  const token = tokenFromHash(useLocation().hash)
  const navigate = useNavigate()
  const { user, signOut } = useAuth()
  const [password, setPassword] = useState('')
  const [touched, setTouched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expired, setExpired] = useState(false)
  const [busy, setBusy] = useState(false)

  const passwordError =
    touched && password.length < MIN_PASSWORD ? `Use at least ${MIN_PASSWORD} characters.` : null

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setTouched(true)
    if (!token || password.length < MIN_PASSWORD) return
    setBusy(true)
    setError(null)
    try {
      await authApi.resetPassword(token, password)
      // Every session ended on the server, this one included.
      if (user) await signOut().catch(() => undefined)
      navigate('/login', {
        replace: true,
        state: { notice: 'Your password is changed. Sign in with the new one.' },
      })
    } catch (caught) {
      const code = caught instanceof ApiError ? caught.code : null
      setExpired(code === 'token_expired' || code === 'invalid_token')
      setError(describeError(caught))
      setBusy(false)
    }
  }

  return (
    <AuthLayout
      title="Choose a new password"
      subtitle="Signing in with it signs you out everywhere else."
      footer={
        <Link to="/login" className="font-medium text-indigo-600 dark:text-indigo-400">
          Back to sign in
        </Link>
      }
    >
      {!token ? (
        <LinkProblem>This link is incomplete. Open it again from the email.</LinkProblem>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          {error && (
            <Alert>
              {error}{' '}
              {expired && (
                <Link to="/forgot-password" className="font-medium underline">
                  Get a new link
                </Link>
              )}
            </Alert>
          )}
          <TextField
            label="New password"
            type="password"
            autoComplete="new-password"
            required
            maxLength={128}
            hint={`At least ${MIN_PASSWORD} characters.`}
            error={passwordError}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onBlur={() => setTouched(true)}
          />
          <Button type="submit" busy={busy} disabled={!password}>
            {busy ? 'Saving…' : 'Set new password'}
          </Button>
        </form>
      )}
    </AuthLayout>
  )
}

function LinkProblem({ children }: { children: string }) {
  return (
    <div className="flex flex-col gap-3">
      <Alert>{children}</Alert>
      <Link
        to="/forgot-password"
        className="text-sm font-medium text-indigo-600 dark:text-indigo-400"
      >
        Get a new link
      </Link>
    </div>
  )
}
