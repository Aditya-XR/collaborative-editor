import { http, HttpResponse } from 'msw'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { server } from '../../test/server'
import { ADA, apiError, sessionFor } from '../../test/fixtures'
import { SessionManager } from './session'

function newManager() {
  const manager = new SessionManager()
  onTestFinished(() => manager.dispose())
  return manager
}

describe('SessionManager', () => {
  it('shares one refresh request between concurrent callers', async () => {
    let calls = 0
    server.use(
      http.post('*/api/auth/refresh', async () => {
        calls += 1
        return HttpResponse.json(sessionFor(ADA, 'fresh'))
      }),
    )
    const manager = newManager()

    const tokens = await Promise.all([
      manager.refreshAccessToken(),
      manager.refreshAccessToken(),
      manager.refreshAccessToken(),
    ])

    expect(calls).toBe(1)
    expect(tokens).toEqual(['fresh', 'fresh', 'fresh'])
    expect(manager.user).toEqual(ADA)
    expect(manager.getAccessToken()).toBe('fresh')
  })

  it('retries once when another tab rotated the cookie first', async () => {
    const responses = [apiError(401, 'refresh_race'), HttpResponse.json(sessionFor(ADA, 'after'))]
    server.use(http.post('*/api/auth/refresh', () => responses.shift()))
    const manager = newManager()

    await expect(manager.refreshAccessToken()).resolves.toBe('after')
  })

  it('ends the session when the refresh token is rejected', async () => {
    server.use(http.post('*/api/auth/refresh', () => apiError(401, 'refresh_token_reused')))
    const manager = newManager()
    manager.start(sessionFor(ADA))
    const listener = vi.fn()
    manager.subscribe(listener)

    await expect(manager.refreshAccessToken()).resolves.toBeNull()

    expect(manager.user).toBeNull()
    expect(manager.getAccessToken()).toBeNull()
    expect(listener).toHaveBeenCalledOnce()
  })

  it('keeps the session when the server is unreachable', async () => {
    server.use(http.post('*/api/auth/refresh', () => HttpResponse.error()))
    const manager = newManager()
    manager.start(sessionFor(ADA))

    await expect(manager.refreshAccessToken()).rejects.toThrow()

    expect(manager.user).toEqual(ADA)
  })

  it('notifies subscribers on sign-in and sign-out', () => {
    const manager = newManager()
    const listener = vi.fn()
    manager.subscribe(listener)

    manager.start(sessionFor(ADA))
    manager.signOut()

    expect(listener).toHaveBeenCalledTimes(2)
    expect(manager.getSnapshot()).toBeNull()
  })
})
