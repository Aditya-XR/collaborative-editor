import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { closeOutboxes } from '../features/offline/outboxes'
import { apiReachability, setTokenSource } from '../lib/api'
import { resetPins } from '../lib/pins'
import { resetUnsynced } from '../lib/unsynced'
import { server } from './server'

// findBy* queries wait up to 15 s instead of 1 s: the lazily loaded editor chunk can take seconds
// to import while other test files run alongside (5 s still timed out on a busy machine).
configure({ asyncUtilTimeout: 15_000 })

// jsdom does no layout, and Range lacks the measuring methods ProseMirror calls when it
// scrolls the selection into view (after Undo, for instance). Report an empty box.
Range.prototype.getClientRects ??= function () {
  return Object.assign([], { item: () => null }) as unknown as DOMRectList
}
Range.prototype.getBoundingClientRect ??= () => new DOMRect()

// Any request without a handler fails the test, so no call goes unnoticed.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))

afterEach(() => {
  cleanup()
  server.resetHandlers()
  setTokenSource(null)
  // A test that took the API away must not leave the next one "offline", and each test starts
  // with nothing queued, pinned or saved: those live for the page, which outlasts a test.
  apiReachability.reset()
  closeOutboxes()
  localStorage.clear()
  resetPins()
  resetUnsynced()
})

afterAll(() => server.close())
