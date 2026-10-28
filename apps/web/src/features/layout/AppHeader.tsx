import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Button } from '../../components/ui/Button'
import { useReachable } from '../../lib/network'
import { setTheme, useTheme, type Theme } from '../../lib/theme'
import { useAuth } from '../auth/useAuth'
import { VerifyEmailBanner } from '../auth/VerifyEmailBanner'
import { ConnectionBadge, OutboxFailures, UpdateBanner } from '../offline/ConnectionBadge'
import { usePendingChanges } from '../offline/useOutbox'

const THEMES: { value: Theme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

export function AppHeader() {
  const { user, signOut, signOutEverywhere } = useAuth()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const theme = useTheme()
  const online = useReachable()
  const waiting = usePendingChanges()

  async function run(action: () => Promise<void>) {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
      navigate('/login', { replace: true })
    }
  }

  return (
    <>
      <header className="border-b border-slate-200 bg-white print:hidden dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-3">
          <Link
            to="/"
            className="font-semibold tracking-tight text-indigo-600 dark:text-indigo-400"
          >
            CollabEdit
          </Link>
          <div className="flex min-w-0 items-center gap-2">
            <ConnectionBadge />
            {user && (
              <details className="relative">
                <summary className="cursor-pointer list-none truncate rounded-lg px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800">
                  {user.name}
                </summary>
                <div className="absolute right-0 z-10 mt-2 flex w-60 flex-col rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg dark:border-slate-700 dark:bg-slate-900">
                  <p className="truncate px-2.5 py-1.5 text-xs text-slate-500 dark:text-slate-400">
                    {user.email}
                  </p>
                  <div
                    role="radiogroup"
                    aria-label="Theme"
                    className="mx-1 my-1 grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800"
                  >
                    {THEMES.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={theme === option.value}
                        onClick={() => setTheme(option.value)}
                        className="rounded-md px-2 py-1 text-xs font-medium text-slate-600 aria-checked:bg-white aria-checked:text-slate-900 aria-checked:shadow-sm dark:text-slate-300 dark:aria-checked:bg-slate-950 dark:aria-checked:text-slate-100"
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  {(!online || waiting > 0) && (
                    // Signing out deletes everything this device keeps, unsent changes included.
                    <p className="px-2.5 py-1.5 text-xs text-amber-800 dark:text-amber-200">
                      {waiting > 0
                        ? `Signing out now deletes ${waiting} ${waiting === 1 ? 'change' : 'changes'} not sent yet.`
                        : 'You’re offline: signing out deletes edits not sent yet.'}
                    </p>
                  )}
                  <Button
                    variant="ghost"
                    className="justify-start"
                    busy={busy}
                    onClick={() => run(signOut)}
                  >
                    Sign out
                  </Button>
                  <Button
                    variant="ghost"
                    className="justify-start"
                    busy={busy}
                    onClick={() => run(signOutEverywhere)}
                  >
                    Sign out of all devices
                  </Button>
                </div>
              </details>
            )}
          </div>
        </div>
      </header>
      <UpdateBanner />
      <OutboxFailures />
      <VerifyEmailBanner />
    </>
  )
}
