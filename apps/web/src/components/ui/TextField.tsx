import { useId, type InputHTMLAttributes } from 'react'

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string
  hint?: string
  error?: string | null
}

export function TextField({ label, hint, error, className = '', ...props }: TextFieldProps) {
  const id = useId()
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined

  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <label htmlFor={id} className="text-sm font-medium text-slate-700 dark:text-slate-200">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-xs outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 aria-invalid:border-rose-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        {...props}
      />
      {error ? (
        <p id={`${id}-error`} className="text-sm text-rose-600 dark:text-rose-400">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-sm text-slate-500 dark:text-slate-400">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
