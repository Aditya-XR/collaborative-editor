import { useQuery } from '@tanstack/react-query'
import { fetchReadiness } from './api'

type Tone = 'muted' | 'good' | 'warn' | 'bad'

const DOT_CLASS: Record<Tone, string> = {
  muted: 'bg-slate-400',
  good: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-rose-500',
}

function StatusLine({ tone, label }: { tone: Tone; label: string }) {
  return (
    <p
      role="status"
      className="inline-flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300"
    >
      <span aria-hidden="true" className={`size-2 rounded-full ${DOT_CLASS[tone]}`} />
      {label}
    </p>
  )
}

export function ApiStatus() {
  const { data, isPending, isError } = useQuery({
    queryKey: ['readiness'],
    queryFn: fetchReadiness,
    refetchInterval: 10_000,
    retry: false,
  })

  if (isPending) return <StatusLine tone="muted" label="Checking API…" />
  if (isError) return <StatusLine tone="bad" label="API unreachable" />

  const failing = Object.entries(data.checks)
    .filter(([, check]) => check.status === 'error')
    .map(([name]) => name)

  if (failing.length === 0) return <StatusLine tone="good" label="API ready" />
  return <StatusLine tone="warn" label={`API degraded: ${failing.join(', ')} unavailable`} />
}
