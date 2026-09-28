const PALETTE = [
  '#e11d48',
  '#ea580c',
  '#ca8a04',
  '#16a34a',
  '#0891b2',
  '#2563eb',
  '#7c3aed',
  '#db2777',
]

/** A stable colour per user, so someone's cursor looks the same in every tab and session. */
export function colorFor(userId: string): string {
  let hash = 0
  for (const character of userId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return PALETTE[hash % PALETTE.length]
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const letters = parts.length > 1 ? [parts[0], parts.at(-1)!] : parts
  return letters.map((part) => [...part][0]?.toUpperCase() ?? '').join('') || '?'
}
