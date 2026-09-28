import { Link } from 'react-router'

export function NotFoundPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-4 px-4">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <Link to="/" className="text-indigo-600 underline dark:text-indigo-400">
        Back to home
      </Link>
    </main>
  )
}
