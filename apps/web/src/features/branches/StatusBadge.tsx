import { STATUS_LABEL, type BranchStatus } from './api'

const STATUS_CLASS: Record<BranchStatus, string> = {
  open: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  merged: 'bg-violet-50 text-violet-800 dark:bg-violet-950 dark:text-violet-200',
  closed: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
}

export function StatusBadge({ status }: { status: BranchStatus }) {
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  )
}
