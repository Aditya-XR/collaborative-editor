import { useSyncExternalStore } from 'react'

export type Theme = 'system' | 'light' | 'dark'

/**
 * Not under the "collabedit:" prefix that signing out clears: a colour scheme says nothing about
 * anyone, and the next person on a shared computer may as well keep it. index.html reads the
 * same key before the page paints, so a dark page never flashes white.
 */
const KEY = 'collabedit-theme'
const listeners = new Set<() => void>()

function systemPrefersDark(): boolean {
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

export function getTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY)
    return saved === 'light' || saved === 'dark' ? saved : 'system'
  } catch {
    return 'system'
  }
}

function apply(dark: boolean): void {
  const root = globalThis.document?.documentElement
  if (!root) return
  root.classList.toggle('dark', dark)
  root.style.colorScheme = dark ? 'dark' : 'light'
}

function applyChosen(): void {
  const theme = getTheme()
  apply(theme === 'dark' || (theme === 'system' && systemPrefersDark()))
}

export function setTheme(theme: Theme): void {
  try {
    if (theme === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, theme)
  } catch {
    // Blocked: the choice lasts until the page reloads.
  }
  applyChosen()
  for (const listener of listeners) listener()
}

/** Follows the system setting while "system" is chosen, and prints on white. Call once. */
export function startTheme(): void {
  applyChosen()
  globalThis.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', applyChosen)
  globalThis.addEventListener('beforeprint', () => apply(false))
  globalThis.addEventListener('afterprint', applyChosen)
  // Another tab changed it.
  globalThis.addEventListener('storage', (event) => {
    if (event.key !== KEY) return
    applyChosen()
    for (const listener of listeners) listener()
  })
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getTheme,
    () => 'system',
  )
}
