import type { RouteObject } from 'react-router'
import { RedirectIfSignedIn, RequireAuth } from '../features/auth/guards'
import { LoginPage } from '../features/auth/LoginPage'
import { RegisterPage } from '../features/auth/RegisterPage'
import { DashboardPage } from '../features/documents/DashboardPage'
import { AcceptLinkPage } from '../features/sharing/AcceptLinkPage'
import { FullPageSpinner } from '../components/ui/Spinner'
import { NotFoundPage } from './NotFoundPage'

export const routes: RouteObject[] = [
  {
    // Shown while a lazily loaded route (the editor) downloads, e.g. when a shared document
    // link is opened directly. Without it the page stays blank until the chunk arrives.
    hydrateFallbackElement: <FullPageSpinner label="Loading" />,
    children: [
      {
        element: <RedirectIfSignedIn />,
        children: [
          { path: '/login', element: <LoginPage /> },
          { path: '/register', element: <RegisterPage /> },
        ],
      },
      {
        element: <RequireAuth />,
        children: [
          { path: '/', element: <DashboardPage /> },
          // Signed-out visitors go to sign-in first and come back here afterwards.
          { path: '/share/:token', element: <AcceptLinkPage /> },
          {
            path: '/d/:documentId',
            // The editor (Tiptap, ProseMirror, Yjs) is most of the JavaScript; sign-in and the
            // dashboard load without it.
            lazy: async () => ({
              Component: (await import('../features/editor/EditorPage')).EditorPage,
            }),
          },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]
