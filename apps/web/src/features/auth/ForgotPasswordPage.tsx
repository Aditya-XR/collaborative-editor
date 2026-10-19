import { useState, type FormEvent } from 'react'
import { Link, useLocation } from 'react-router'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { TextField } from '../../components/ui/TextField'
import { describeError } from '../../lib/errors'
import { authApi } from './api'
import { AuthLayout } from './AuthLayout'

export function ForgotPasswordPage() {
  // Carried over from the sign-in page, so the address need not be typed twice.
  const typed = (useLocation().state as { email?: string } | null)?.email ?? ''
  const [email, setEmail] = useState(typed)
  const [sent, setSent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      // The answer is the same whether or not an account uses the address.
      setSent((await authApi.forgotPassword(email.trim())).detail)
    } catch (caught) {
      setError(describeError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="We'll email you a link to choose a new one."
      footer={
        <Link to="/login" className="font-medium text-indigo-600 dark:text-indigo-400">
          Back to sign in
        </Link>
      }
    >
      {sent ? (
        <p role="status" className="text-sm text-slate-700 dark:text-slate-200">
          {sent} The link works for 30 minutes. Check your spam folder if it does not arrive.
        </p>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          {error && <Alert>{error}</Alert>}
          <TextField
            label="Email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <Button type="submit" busy={busy} disabled={!email.trim()}>
            {busy ? 'Sending…' : 'Email me a link'}
          </Button>
        </form>
      )}
    </AuthLayout>
  )
}
