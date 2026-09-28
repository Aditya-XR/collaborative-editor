import { Link, useParams } from 'react-router'
import { Alert } from '../../components/ui/Alert'
import { Spinner } from '../../components/ui/Spinner'
import { describeError } from '../../lib/errors'
import { AppHeader } from '../layout/AppHeader'
import { useDocument } from './queries'

export function DocumentPage() {
  const { documentId = '' } = useParams()
  const document = useDocument(documentId)

  return (
    <div className="min-h-dvh bg-slate-50 dark:bg-slate-950">
      <AppHeader />
      <main className="mx-auto max-w-4xl px-4 py-8">
        <Link to="/" className="text-sm text-indigo-600 dark:text-indigo-400">
          ← All documents
        </Link>
        {document.isPending ? (
          <div className="flex justify-center py-12 text-indigo-600">
            <Spinner />
          </div>
        ) : document.isError ? (
          <div className="mt-6">
            <Alert>{describeError(document.error)}</Alert>
          </div>
        ) : (
          <article className="mt-6 rounded-2xl border border-slate-200 bg-white p-8 dark:border-slate-800 dark:bg-slate-900">
            <h1 className="text-3xl font-semibold tracking-tight">{document.data.title}</h1>
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
              Owned by {document.data.owner.name}
            </p>
            <p className="mt-8 rounded-lg bg-indigo-50 px-4 py-3 text-sm text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200">
              The live collaborative editor arrives in phase 2.
            </p>
          </article>
        )}
      </main>
    </div>
  )
}
