/// <reference types="vite-plugin-pwa/vanillajs" />
import { useSyncExternalStore } from 'react'

/** Deploys are a few a day at most; a page left open notices one within the hour. */
const UPDATE_CHECK_MS = 60 * 60 * 1000

let activate: ((reload?: boolean) => Promise<void>) | null = null
let waiting = false
const listeners = new Set<() => void>()

/**
 * Installs the service worker that keeps the app itself (HTML, scripts, styles, icons) on this
 * device, so it opens with no network (ADR 0019). Only in built apps: in development every file
 * changes all the time.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  void import('virtual:pwa-register').then(({ registerSW }) => {
    activate = registerSW({
      // A new version waits until the person says so: reloading under someone mid-sentence would
      // be rude, even though their text is safe in IndexedDB.
      onNeedRefresh() {
        waiting = true
        for (const listener of listeners) listener()
      },
      onRegisteredSW(_url, registration) {
        if (registration) setInterval(() => void registration.update(), UPDATE_CHECK_MS)
      },
    })
  })
}

/** A newer version of the app has been downloaded and is waiting for a reload. */
export function useUpdateWaiting(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => waiting,
    () => false,
  )
}

/** Switches to the waiting version and reloads the page. */
export function applyUpdate(): void {
  void activate?.(true)
}
