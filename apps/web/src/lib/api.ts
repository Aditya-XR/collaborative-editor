// In development Vite proxies /api to the FastAPI server; in production Vercel rewrites it.
export const API_URL: string = import.meta.env.VITE_API_URL ?? '/api'

export class ApiError extends Error {
  readonly status: number
  readonly code: string | null
  readonly retryAfterSeconds: number | null

  constructor(status: number, code: string | null, message: string, retryAfter: number | null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryAfterSeconds = retryAfter
  }
}

/** How the API client obtains and renews access tokens; provided by the session manager. */
export interface TokenSource {
  getAccessToken(): string | null
  refreshAccessToken(): Promise<string | null>
}

let tokens: TokenSource | null = null

export function setTokenSource(source: TokenSource | null): void {
  tokens = source
}

export function apiUrl(path: string): string {
  // Absolute, so the same code works in the browser and under Node in tests.
  return new URL(`${API_URL}${path}`, globalThis.location.origin).toString()
}

interface RequestOptions {
  method?: string
  body?: unknown
  /** Send the access token and refresh it once if it has expired. Default true. */
  auth?: boolean
  signal?: AbortSignal
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true, signal } = options

  const send = (token: string | null): Promise<Response> => {
    const headers: Record<string, string> = {}
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (token) headers.Authorization = `Bearer ${token}`
    return fetch(apiUrl(path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'include',
      signal,
    })
  }

  let response = await send(auth ? (tokens?.getAccessToken() ?? null) : null)

  if (
    auth &&
    tokens &&
    response.status === 401 &&
    (await errorCode(response)) === 'token_expired'
  ) {
    const fresh = await tokens.refreshAccessToken()
    if (fresh) response = await send(fresh)
  }

  if (!response.ok) throw await toApiError(response)
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as { code?: unknown }
    return typeof body.code === 'string' ? body.code : null
  } catch {
    return null
  }
}

interface ValidationIssue {
  loc?: unknown[]
  msg?: string
  ctx?: { reason?: string }
}

/** FastAPI reports validation as a list of per-field issues; show the first one. */
function describeValidationIssue(issue: ValidationIssue): string {
  const field = issue.loc?.at(-1)
  const reason = issue.ctx?.reason ?? issue.msg ?? 'is invalid'
  if (typeof field !== 'string') return reason
  return `${field.charAt(0).toUpperCase()}${field.slice(1)}: ${reason}`
}

export async function toApiError(response: Response): Promise<ApiError> {
  let code: string | null = null
  let message = `Request failed with status ${response.status}`
  try {
    const body = (await response.json()) as { code?: unknown; detail?: unknown }
    if (typeof body.code === 'string') code = body.code
    if (typeof body.detail === 'string') message = body.detail
    else if (Array.isArray(body.detail) && body.detail.length > 0) {
      message = describeValidationIssue(body.detail[0] as ValidationIssue)
    }
  } catch {
    // Not JSON (e.g. a proxy error page): keep the generic message.
  }
  const retryAfter = Number(response.headers.get('Retry-After'))
  return new ApiError(
    response.status,
    code,
    message,
    Number.isFinite(retryAfter) ? retryAfter : null,
  )
}
