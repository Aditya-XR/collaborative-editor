import type { CollabState } from './CollabProvider'

type Tone = 'good' | 'busy' | 'warn' | 'bad'

const TONE_CLASS: Record<Tone, string> = {
  good: 'bg-emerald-500',
  busy: 'bg-sky-500 animate-pulse',
  warn: 'bg-amber-500',
  bad: 'bg-rose-500',
}

function describe(state: CollabState): { tone: Tone; label: string } {
  if (state.status === 'stopped') return { tone: 'bad', label: 'Disconnected' }
  if (state.status === 'online' && state.synced)
    return { tone: 'good', label: 'All changes synced' }
  if (state.status === 'online' || state.status === 'connecting') {
    return { tone: 'busy', label: 'Syncing…' }
  }
  const pending = state.unsynced
  return {
    tone: 'warn',
    label:
      pending > 0
        ? `Offline · ${pending} ${pending === 1 ? 'change' : 'changes'} saved on this device`
        : 'Offline · edits are saved on this device',
  }
}

export function SyncStatus({ state }: { state: CollabState }) {
  const { tone, label } = describe(state)
  return (
    <p
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300"
    >
      <span aria-hidden="true" className={`size-2 rounded-full ${TONE_CLASS[tone]}`} />
      {label}
    </p>
  )
}
