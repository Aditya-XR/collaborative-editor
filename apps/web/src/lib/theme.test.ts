import { describe, expect, it, vi } from 'vitest'
import { getTheme, setTheme, startTheme } from './theme'

function systemDark(dark: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: dark && query === '(prefers-color-scheme: dark)',
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

const isDark = () => document.documentElement.classList.contains('dark')

describe('theme', () => {
  it('follows the system until someone picks light or dark, and remembers the pick', () => {
    systemDark(true)
    startTheme()
    expect(getTheme()).toBe('system')
    expect(isDark()).toBe(true)

    setTheme('light')
    expect(isDark()).toBe(false)
    expect(localStorage.getItem('collabedit-theme')).toBe('light')

    setTheme('system')
    expect(isDark()).toBe(true)
    expect(localStorage.getItem('collabedit-theme')).toBeNull()
  })

  it('prints on white, then goes back', () => {
    systemDark(false)
    setTheme('dark')
    startTheme()

    globalThis.dispatchEvent(new Event('beforeprint'))
    expect(isDark()).toBe(false)
    globalThis.dispatchEvent(new Event('afterprint'))
    expect(isDark()).toBe(true)
    setTheme('system')
  })
})
