import { Link } from 'react-router'
import { Alert } from '../../components/ui/Alert'
import { Spinner } from '../../components/ui/Spinner'
import { describeError } from '../../lib/errors'
import { timeAgo } from '../../lib/time'
import type { SearchHit } from './api'
import { useDocumentSearch } from './queries'

export function SearchResults({ query, currentUserId }: { query: string; currentUserId: string }) {
  const search = useDocumentSearch(query)

  if (search.isPending) {
    return (
      <div className="flex justify-center py-12 text-indigo-600">
        <Spinner />
      </div>
    )
  }
  if (search.isError) {
    return (
      <div className="p-4">
        <Alert>{describeError(search.error)}</Alert>
      </div>
    )
  }
  if (search.data.length === 0) {
    return (
      <p className="px-4 py-12 text-center text-sm text-slate-500 dark:text-slate-400">
        No documents match “{query}”.
      </p>
    )
  }
  return (
    <ul
      aria-label="Search results"
      aria-busy={search.isFetching || undefined}
      className="divide-y divide-slate-100 dark:divide-slate-800"
    >
      {search.data.map((hit) => (
        <SearchResult key={hit.document.id} hit={hit} currentUserId={currentUserId} />
      ))}
    </ul>
  )
}

function SearchResult({ hit, currentUserId }: { hit: SearchHit; currentUserId: string }) {
  const { document, snippet } = hit
  const owner = document.owner.id === currentUserId ? 'You' : document.owner.name
  return (
    <li className="px-4 py-3">
      <Link
        to={`/d/${document.id}`}
        className="block truncate font-medium hover:text-indigo-600 dark:hover:text-indigo-400"
      >
        {document.title}
      </Link>
      {snippet.length > 0 && (
        // Plain text parts, never HTML: a document's own words cannot inject markup here.
        <p className="mt-1 line-clamp-2 text-sm text-slate-600 dark:text-slate-300">
          {snippet.map((part, index) =>
            part.match ? (
              <mark
                key={index}
                className="rounded-sm bg-amber-200 px-0.5 text-inherit dark:bg-amber-700/60"
              >
                {part.text}
              </mark>
            ) : (
              <span key={index}>{part.text}</span>
            ),
          )}
        </p>
      )}
      <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
        {owner} · Edited {timeAgo(document.updated_at)}
      </p>
    </li>
  )
}
