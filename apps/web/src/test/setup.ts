import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { setTokenSource } from '../lib/api'
import { server } from './server'

// findBy* queries wait up to 5 s instead of 1 s: the lazily loaded editor chunk can take longer
// than a second to import on a busy CI runner, which made those tests flaky under load.
configure({ asyncUtilTimeout: 5000 })

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
})

afterAll(() => server.close())
