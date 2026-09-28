import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Button } from '../../components/ui/Button'
import { useAuth } from '../auth/useAuth'

export function AppHeader() {
  const { user, signOut, signOutEverywhere } = useAuth()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)

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
    <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-3">
        <Link to="/" className="font-semibold tracking-tight text-indigo-600 dark:text-indigo-400">
          CollabEdit
        </Link>
        {user && (
          <details className="relative">
            <summary className="cursor-pointer list-none rounded-lg px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800">
              {user.name}
            </summary>
            <div className="absolute right-0 z-10 mt-2 flex w-56 flex-col rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg dark:border-slate-700 dark:bg-slate-900">
              <p className="truncate px-2.5 py-1.5 text-xs text-slate-500 dark:text-slate-400">
                {user.email}
              </p>
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
    </header>
  )
}
