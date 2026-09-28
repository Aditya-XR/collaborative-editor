import type { RouteObject } from 'react-router'
import { RedirectIfSignedIn, RequireAuth } from '../features/auth/guards'
import { LoginPage } from '../features/auth/LoginPage'
import { RegisterPage } from '../features/auth/RegisterPage'
import { DashboardPage } from '../features/documents/DashboardPage'
import { NotFoundPage } from './NotFoundPage'

export const routes: RouteObject[] = [
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
]
