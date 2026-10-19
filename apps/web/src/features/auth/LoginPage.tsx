import { useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { TextField } from '../../components/ui/TextField'
import { describeError } from '../../lib/errors'
import { GOOGLE_ERRORS } from './api'
import { AuthLayout } from './AuthLayout'
import { GoogleSignIn } from './GoogleSignIn'
import { useAuth } from './useAuth'

export function LoginPage() {
  const { signIn } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  // A Google sign-in that did not work comes back here with ?error=…
  const [searchParams] = useSearchParams()
  const googleError = searchParams.get('error')
  const [error, setError] = useState<string | null>(
    googleError ? (GOOGLE_ERRORS[googleError] ?? GOOGLE_ERRORS.google_failed) : null,
  )
  const [busy, setBusy] = useState(false)
  // Set by the reset page after a new password was chosen.
  const notice = (location.state as { notice?: string } | null)?.notice

  const from = (location.state as { from?: string } | null)?.from ?? '/'

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await signIn({ email, password })
      navigate(from, { replace: true })
    } catch (caught) {
      setError(describeError(caught))
      setBusy(false)
    }
  }

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Welcome back. Pick up where you left off."
      footer={
        <>
          New here?{' '}
          <Link to="/register" className="font-medium text-indigo-600 dark:text-indigo-400">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        {notice && !error && (
          <p
            role="status"
            className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
          >
            {notice}
          </p>
        )}
        {error && <Alert>{error}</Alert>}
        <GoogleSignIn next={from} />
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <div className="flex flex-col gap-1.5">
          <TextField
            label="Password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <Link
            to="/forgot-password"
            state={{ email }}
            className="self-end text-xs font-medium text-indigo-600 dark:text-indigo-400"
          >
            Forgot password?
          </Link>
        </div>
        <Button type="submit" busy={busy} disabled={!email || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </AuthLayout>
  )
}
