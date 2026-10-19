import { api, apiUrl } from '../../lib/api'
import type { SessionResponse, User } from './session'

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
  options: () => api<{ google: boolean }>('/auth/options', { auth: false }),
  forgotPassword: (email: string) =>
    api<{ detail: string }>('/auth/password/forgot', {
      method: 'POST',
      body: { email },
      auth: false,
    }),
  resetPassword: (token: string, password: string) =>
    api<void>('/auth/password/reset', { method: 'POST', body: { token, password }, auth: false }),
  verifyEmail: (token: string) =>
    api<User>('/auth/email/verify', { method: 'POST', body: { token }, auth: false }),
  resendVerification: () => api<{ detail: string }>('/auth/email/resend', { method: 'POST' }),
}

/** A full-page navigation, not a fetch: Google's sign-in screen is a page of its own. */
export function googleSignInUrl(next = '/'): string {
  return apiUrl(`/auth/google/start?next=${encodeURIComponent(next)}`)
}

/** Read from the address after `#`, which browsers never send to a server. */
export function tokenFromHash(hash: string): string | null {
  return new URLSearchParams(hash.replace(/^#/, '')).get('token')
}

/** Why a Google sign-in came back to the sign-in page (the API's ?error=…). */
export const GOOGLE_ERRORS: Record<string, string> = {
  google_cancelled: 'Google sign-in was cancelled.',
  google_email_unverified: 'Google has not verified that email address, so it cannot be used here.',
  google_unavailable: 'Google could not be reached. Try again in a moment.',
  google_failed: 'Google sign-in did not work. Try again.',
}
