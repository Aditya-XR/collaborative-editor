import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { Spinner } from '../../components/ui/Spinner'
import { describeError } from '../../lib/errors'
import { useDebouncedValue } from '../../lib/useDebouncedValue'
import { useAuth } from '../auth/useAuth'
import { ApiStatus } from '../health/ApiStatus'
import { AppHeader } from '../layout/AppHeader'
import { DASHBOARD_VIEWS, type DashboardView } from './api'
import { DocumentRow } from './DocumentRow'
import { useCreateDocument, useDocuments } from './queries'
import { SearchResults } from './SearchResults'

const SEARCH_DELAY_MS = 250

const EMPTY: Record<DashboardView, string> = {
  all: 'No documents yet. Create one to get started.',
  owned: "You haven't created any documents yet.",
  shared: 'Nothing has been shared with you yet.',
  trash: 'Trash is empty.',
}

function parseView(value: string | null): DashboardView {
  return DASHBOARD_VIEWS.some((view) => view.value === value) ? (value as DashboardView) : 'all'
}

export function DashboardPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const view = parseView(params.get('view'))
  // The search lives in the URL, so Back from a result returns to the same results.
  const query = params.get('q') ?? ''
  const [typed, setTyped] = useState(query)
  const settled = useDebouncedValue(typed.trim(), SEARCH_DELAY_MS)
  const documents = useDocuments(view)
  const create = useCreateDocument()

  useEffect(() => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        if (settled) next.set('q', settled)
        else next.delete('q')
        return next
      },
      { replace: true },
    )
  }, [settled, setParams])

  function showView(next: DashboardView) {
    setTyped('')
    setParams(next === 'all' ? {} : { view: next })
  }

  async function onCreate() {
    const document = await create.mutateAsync(undefined)
    navigate(`/d/${document.id}`)
  }

  return (
    <div className="min-h-dvh bg-slate-50 dark:bg-slate-950">
      <AppHeader />
      <main className="mx-auto max-w-4xl px-4 py-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">Documents</h1>
          <Button onClick={onCreate} busy={create.isPending}>
            New document
          </Button>
        </div>

        <input
          type="search"
          aria-label="Search documents"
          placeholder="Search titles and text"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          maxLength={200}
          className="mt-6 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 dark:border-slate-700 dark:bg-slate-900"
        />

        <nav aria-label="Document filters" className="mt-4 flex flex-wrap gap-1">
          {DASHBOARD_VIEWS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-current={!query && view === option.value ? 'page' : undefined}
              onClick={() => showView(option.value)}
              className="rounded-full px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-200 aria-[current=page]:bg-indigo-600 aria-[current=page]:text-white dark:text-slate-300 dark:hover:bg-slate-800"
            >
              {option.label}
            </button>
          ))}
        </nav>

        <section className="mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          {create.isError && <Alert>{describeError(create.error)}</Alert>}
          {query ? (
            <SearchResults query={query} currentUserId={user!.id} />
          ) : documents.isPending ? (
            <div className="flex justify-center py-12 text-indigo-600">
              <Spinner />
            </div>
          ) : documents.isError ? (
            <div className="p-4">
              <Alert>{describeError(documents.error)}</Alert>
            </div>
          ) : documents.data.length === 0 ? (
            <p className="px-4 py-12 text-center text-sm text-slate-500 dark:text-slate-400">
              {EMPTY[view]}
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {documents.data.map((document) => (
                <DocumentRow key={document.id} document={document} currentUserId={user!.id} />
              ))}
            </ul>
          )}
        </section>

        <footer className="mt-8">
          <ApiStatus />
        </footer>
      </main>
    </div>
  )
}
