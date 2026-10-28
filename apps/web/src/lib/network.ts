import { useSyncExternalStore } from 'react'
import { ApiError, apiReachability, isEdgeStatus } from './api'

function subscribe(listener: () => void): () => void {
  globalThis.addEventListener('online', listener)
  globalThis.addEventListener('offline', listener)
  const stopApi = apiReachability.subscribe(listener)
  return () => {
    globalThis.removeEventListener('online', listener)
    globalThis.removeEventListener('offline', listener)
    stopApi()
  }
}

/** The browser's own idea of the network. False is reliable; true may still fail. */
export function isBrowserOnline(): boolean {
  return globalThis.navigator?.onLine ?? true
}

/** Whether the API can be reached: the browser has a network and the last request got an answer. */
export function isReachable(): boolean {
  return isBrowserOnline() && apiReachability.isReachable()
}

/** Re-renders when the network goes or comes back, or the API stops or starts answering. */
export function useReachable(): boolean {
  return useSyncExternalStore(subscribe, isReachable, () => true)
}

/**
 * The request never got an answer from the API: no network (fetch throws a TypeError), or the
 * hosting edge answered for a sleeping or restarting server. Worth retrying later, unlike a
 * refusal from the API itself.
 */
export function isUnreachable(error: unknown): boolean {
  if (error instanceof ApiError) return isEdgeStatus(error.status)
  return error instanceof TypeError
}
