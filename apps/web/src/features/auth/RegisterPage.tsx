import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { TextField } from '../../components/ui/TextField'
import { describeError } from '../../lib/errors'
import { AuthLayout } from './AuthLayout'
import { useAuth } from './useAuth'

const MIN_PASSWORD = 8

export function RegisterPage() {
  const { signUp } = useAuth()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [touched, setTouched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const passwordError =
    touched && password.length < MIN_PASSWORD ? `Use at least ${MIN_PASSWORD} characters.` : null

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setTouched(true)
    if (password.length < MIN_PASSWORD) return
    setBusy(true)
    setError(null)
    try {
      await signUp({ name: name.trim(), email, password })
      navigate('/', { replace: true })
    } catch (caught) {
      setError(describeError(caught))
      setBusy(false)
    }
  }

  return (
    <AuthLayout
      title="Create your account"
      subtitle="Write together in real time, even offline."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-indigo-600 dark:text-indigo-400">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        {error && <Alert>{error}</Alert>}
        <TextField
          label="Name"
          autoComplete="name"
          required
          maxLength={100}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          maxLength={128}
          hint={`At least ${MIN_PASSWORD} characters. A short phrase works well.`}
          error={passwordError}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          onBlur={() => setTouched(true)}
        />
        <Button type="submit" busy={busy} disabled={!name.trim() || !email || !password}>
          {busy ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
    </AuthLayout>
  )
}
