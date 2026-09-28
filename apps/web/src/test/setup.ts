import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { setTokenSource } from '../lib/api'
import { server } from './server'

// findBy* queries wait up to 5 s instead of 1 s: the lazily loaded editor chunk can take longer
// than a second to import on a busy CI runner, which made those tests flaky under load.
configure({ asyncUtilTimeout: 5000 })

// Any request without a handler fails the test, so no call goes unnoticed.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))

afterEach(() => {
  cleanup()
  server.resetHandlers()
  setTokenSource(null)
})

afterAll(() => server.close())
