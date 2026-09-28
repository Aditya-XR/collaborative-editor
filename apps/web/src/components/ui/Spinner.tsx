export function Spinner({ className = 'size-5' }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block animate-spin rounded-full border-2 border-current border-r-transparent ${className}`}
    />
  )
}

export function FullPageSpinner({ label }: { label: string }) {
  return (
    <div role="status" className="flex min-h-dvh items-center justify-center text-indigo-600">
      <Spinner className="size-8" />
      <span className="sr-only">{label}</span>
    </div>
  )
}
