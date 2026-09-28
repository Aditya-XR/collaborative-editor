import { api } from '../../lib/api'
import type { SessionResponse } from './session'

export interface Credentials {
  email: string
  password: string
}

export interface Registration extends Credentials {
  name: string
}

export const authApi = {
  login: (body: Credentials) =>
    api<SessionResponse>('/auth/login', { method: 'POST', body, auth: false }),
  register: (body: Registration) =>
    api<SessionResponse>('/auth/register', { method: 'POST', body, auth: false }),
  logout: () => api<void>('/auth/logout', { method: 'POST', auth: false }),
  logoutAll: () => api<void>('/auth/logout-all', { method: 'POST' }),
}
