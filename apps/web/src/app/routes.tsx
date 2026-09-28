import type { RouteObject } from 'react-router'
import { RedirectIfSignedIn, RequireAuth } from '../features/auth/guards'
import { LoginPage } from '../features/auth/LoginPage'
import { RegisterPage } from '../features/auth/RegisterPage'
import { DashboardPage } from '../features/documents/DashboardPage'
import { DocumentPage } from '../features/documents/DocumentPage'
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
      { path: '/d/:documentId', element: <DocumentPage /> },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
]
