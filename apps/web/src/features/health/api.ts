import { apiUrl, toApiError } from '../../lib/api'

export type CheckStatus = 'ok' | 'error'

export interface Readiness {
  status: CheckStatus
  checks: Record<string, { status: CheckStatus; detail: string | null }>
}

// /readyz answers 503 with a full report when a dependency is down, so both codes carry data.
export async function fetchReadiness(): Promise<Readiness> {
  const response = await fetch(apiUrl('/readyz'))
  if (response.status !== 200 && response.status !== 503) throw await toApiError(response)
  return (await response.json()) as Readiness
}
