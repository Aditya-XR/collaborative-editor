import { useState } from 'react'
import { describeError } from '../../lib/errors'
import { authApi } from './api'
import { useAuth } from './useAuth'

/** Asks people who have not confirmed their address yet to do so, with a way to resend. */
export function VerifyEmailBanner() {
  const { user } = useAuth()
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (!user || user.email_verified) return null

  async function resend() {
    setBusy(true)
    try {
      setMessage((await authApi.resendVerification()).detail)
    } catch (caught) {
      setMessage(describeError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      role="region"
      aria-label="Confirm your email"
      className="border-b border-amber-200 bg-amber-50 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"
    >
      <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
        <p className="flex-1">
          {message ??
            `Confirm ${user.email} with the link we emailed you, to get comment notifications and be able to reset your password.`}
        </p>
        {!message && (
          <button
            type="button"
            disabled={busy}
            onClick={resend}
            className="font-medium underline underline-offset-2 disabled:opacity-60"
          >
            {busy ? 'Sending…' : 'Send it again'}
          </button>
        )}
      </div>
    </div>
  )
}
