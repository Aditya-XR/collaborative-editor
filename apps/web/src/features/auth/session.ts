import { apiUrl, setTokenSource, toApiError, type TokenSource } from '../../lib/api'

export interface User {
  id: string
  email: string
  name: string
}

export interface SessionResponse {
  access_token: string
  token_type: string
  expires_in: number
  user: User
}

type Listener = () => void

const REFRESH_LOCK = 'collabedit-auth-refresh'
const CHANNEL = 'collabedit-auth'
// Renew a minute before the access token expires so requests rarely see a 401.
const EARLY_REFRESH_MS = 60_000

/**
 * Holds the access token in memory only (never localStorage, where any injected script could
 * read it). The refresh token lives in an httpOnly cookie the page cannot touch.
 */
export class SessionManager implements TokenSource {
  private accessToken: string | null = null
  private currentUser: User | null = null
  private inflight: Promise<string | null> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly listeners = new Set<Listener>()
  private readonly channel: BroadcastChannel | null

  constructor() {
    this.channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL)
    // Under Node (tests) an open channel would keep the process alive; browsers ignore this.
    ;(this.channel as { unref?: () => void } | null)?.unref?.()
    // Signing out in one tab signs out every tab.
    this.channel?.addEventListener('message', (event: MessageEvent) => {
      if (event.data === 'signed-out') this.clear()
    })
  }

  get user(): User | null {
    return this.currentUser
  }

  getAccessToken(): string | null {
    return this.accessToken
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): User | null => this.currentUser

  start(session: SessionResponse): void {
    this.accessToken = session.access_token
    this.currentUser = session.user
    this.schedule(session.expires_in)
    this.emit()
  }

  /** Ends the session locally and tells other tabs to do the same. */
  signOut(): void {
    this.clear()
    this.channel?.postMessage('signed-out')
  }

  /** Renews the access token. Concurrent callers share one request, across tabs too. */
  refreshAccessToken(): Promise<string | null> {
    this.inflight ??= this.refreshExclusively().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.channel?.close()
  }

  private async refreshExclusively(): Promise<string | null> {
    // The Web Locks API makes tabs take turns, so two tabs never rotate the same refresh
    // token at once (the server would otherwise read the second use as token theft).
    const locks = globalThis.navigator?.locks
    return locks ? locks.request(REFRESH_LOCK, () => this.requestRefresh()) : this.requestRefresh()
  }

  private async requestRefresh(retried = false): Promise<string | null> {
    const response = await fetch(apiUrl('/auth/refresh'), {
      method: 'POST',
      credentials: 'include',
    })
    if (response.ok) {
      this.start((await response.json()) as SessionResponse)
      return this.accessToken
    }
    const error = await toApiError(response)
    // Another tab rotated the cookie a moment ago; the browser now holds the new one.
    if (error.code === 'refresh_race' && !retried) return this.requestRefresh(true)
    if (response.status === 401 || response.status === 403) {
      this.clear()
      return null
    }
    throw error
  }

  private schedule(expiresInSeconds: number): void {
    if (this.timer) clearTimeout(this.timer)
    const delay = Math.max(expiresInSeconds * 1000 - EARLY_REFRESH_MS, 5_000)
    this.timer = setTimeout(() => {
      this.refreshAccessToken().catch(() => {
        // Offline or server down: the next API call retries through the 401 path.
      })
    }, delay)
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const changed = this.currentUser !== null || this.accessToken !== null
    this.accessToken = null
    this.currentUser = null
    if (changed) this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

export const session = new SessionManager()
setTokenSource(session)
