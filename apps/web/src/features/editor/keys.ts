/** How the modifier key is written on this platform: ⌘ on Apple devices, Ctrl elsewhere. */
export const MOD = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '') ? '⌘' : 'Ctrl'
