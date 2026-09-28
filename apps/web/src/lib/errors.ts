import { ApiError } from './api'

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Incorrect email or password.',
  email_taken: 'An account with this email already exists.',
  rate_limiter_unavailable: 'Sign-in is briefly unavailable. Try again in a moment.',
  insufficient_role: "You don't have permission to do that.",
  document_not_found: 'This document does not exist or you no longer have access.',
}

/** A sentence a person can act on, for any error thrown by the API client. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'rate_limited') {
      const wait = error.retryAfterSeconds
      return wait ? `Too many attempts. Try again in ${formatWait(wait)}.` : 'Too many attempts.'
    }
    if (error.code && MESSAGES[error.code]) return MESSAGES[error.code]
    if (error.status >= 500) return 'Something went wrong on our side. Try again shortly.'
    return error.message
  }
  if (error instanceof TypeError) return "Can't reach the server. Check your connection."
  return 'Something went wrong.'
}

function formatWait(seconds: number): string {
  if (seconds < 60) return seconds === 1 ? '1 second' : `${seconds} seconds`
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return minutes === 1 ? '1 minute' : `${minutes} minutes`
  const hours = Math.ceil(minutes / 60)
  return hours === 1 ? '1 hour' : `${hours} hours`
}
