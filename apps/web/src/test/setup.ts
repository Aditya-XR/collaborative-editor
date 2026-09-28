import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { setTokenSource } from '../lib/api'
import { server } from './server'

// Any request without a handler fails the test, so no call goes unnoticed.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))

afterEach(() => {
  cleanup()
  server.resetHandlers()
  setTokenSource(null)
})

afterAll(() => server.close())
