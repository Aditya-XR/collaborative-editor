import { useNavigate, useSearchParams } from 'react-router'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { Spinner } from '../../components/ui/Spinner'
import { describeError } from '../../lib/errors'
import { useAuth } from '../auth/useAuth'
import { ApiStatus } from '../health/ApiStatus'
import { AppHeader } from '../layout/AppHeader'
import { DASHBOARD_VIEWS, type DashboardView } from './api'
import { DocumentRow } from './DocumentRow'
import { useCreateDocument, useDocuments } from './queries'

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
  const documents = useDocuments(view)
  const create = useCreateDocument()

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

        <nav aria-label="Document filters" className="mt-6 flex flex-wrap gap-1">
          {DASHBOARD_VIEWS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-current={view === option.value ? 'page' : undefined}
              onClick={() => setParams(option.value === 'all' ? {} : { view: option.value })}
              className="rounded-full px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-200 aria-[current=page]:bg-indigo-600 aria-[current=page]:text-white dark:text-slate-300 dark:hover:bg-slate-800"
            >
              {option.label}
            </button>
          ))}
        </nav>

        <section className="mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          {create.isError && <Alert>{describeError(create.error)}</Alert>}
          {documents.isPending ? (
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
