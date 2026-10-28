import { useEffect, useState } from 'react'
import { Button } from '../../components/ui/Button'
import { apiReachability } from '../../lib/api'
import { useReachable } from '../../lib/network'
import { applyUpdate, useUpdateWaiting } from '../../lib/serviceWorker'
import { timeAgo } from '../../lib/time'
import { useOutbox, useOutboxSnapshot, usePendingChanges } from './useOutbox'

function changes(count: number): string {
  return `${count} ${count === 1 ? 'change' : 'changes'}`
}

/** Renders again every `ms` while `ticking`, so "2 minutes ago" stays true. */
function useTicking(ticking: boolean, ms = 30_000): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!ticking) return
    const timer = setInterval(() => setTick((tick) => tick + 1), ms)
    return () => clearInterval(timer)
  }, [ticking, ms])
}

/**
 * Says when the app is offline or still sending changes made offline, and how many; nothing at
 * all while everything is sent. Each open document shows its own text's state beside its title.
 */
export function ConnectionBadge() {
  const online = useReachable()
  const pending = usePendingChanges()
  useTicking(!online)
  if (online && pending === 0) return null

  const answered = apiReachability.answeredAt()
  const parts = online
    ? [`Sending ${changes(pending)}…`]
    : [
        'Offline',
        pending > 0 ? `${changes(pending)} not synced` : null,
        answered ? `last online ${timeAgo(new Date(answered).toISOString())}` : null,
      ].filter((part): part is string => part !== null)

  return (
    <p
      role="status"
      aria-live="polite"
      title={parts.join(' · ')}
      className={`inline-flex min-w-0 items-center gap-2 rounded-full px-2.5 py-1 text-xs font-medium ${
        online
          ? 'bg-sky-50 text-sky-800 dark:bg-sky-950 dark:text-sky-200'
          : 'bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100'
      }`}
    >
      <span
        aria-hidden="true"
        className={`size-2 shrink-0 rounded-full ${online ? 'animate-pulse bg-sky-500' : 'bg-amber-500'}`}
      />
      <span className="truncate">
        {parts[0]}
        {parts.length > 1 && (
          <span className="hidden sm:inline"> · {parts.slice(1).join(' · ')}</span>
        )}
      </span>
    </p>
  )
}

/** Changes made offline that the server refused once it was back: they need the person's eyes. */
export function OutboxFailures() {
  const outbox = useOutbox()
  const { failures } = useOutboxSnapshot()
  if (failures.length === 0) return null
  return (
    <div
      role="alert"
      className="border-b border-rose-200 bg-rose-50 text-sm text-rose-900 print:hidden dark:border-rose-900 dark:bg-rose-950 dark:text-rose-100"
    >
      <div className="mx-auto flex max-w-4xl items-start gap-3 px-4 py-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {failures.length === 1
              ? 'A change made offline could not be saved:'
              : `${failures.length} changes made offline could not be saved:`}
          </p>
          <ul className="mt-1 list-disc pl-5">
            {failures.map(({ id, label, message }) => (
              <li key={id}>
                {label}: {message}
              </li>
            ))}
          </ul>
        </div>
        <Button variant="ghost" onClick={() => outbox?.dismissFailures()}>
          Dismiss
        </Button>
      </div>
    </div>
  )
}

/** A new version of the app is downloaded: offer it, rather than reload under someone typing. */
export function UpdateBanner() {
  const waiting = useUpdateWaiting()
  if (!waiting) return null
  return (
    <div
      role="status"
      className="border-b border-indigo-200 bg-indigo-50 text-sm text-indigo-900 print:hidden dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-100"
    >
      <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-2">
        <p className="flex-1">A new version of CollabEdit is ready.</p>
        <Button variant="secondary" onClick={applyUpdate}>
          Reload
        </Button>
      </div>
    </div>
  )
}
