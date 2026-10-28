import { describe, expect, it } from 'vitest'
import { uuid7 } from './uuid7'

describe('uuid7', () => {
  it('is a version 7 UUID that starts with its creation time', () => {
    const id = uuid7(Date.UTC(2026, 9, 22, 12, 0, 0))

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(parseInt(id.replaceAll('-', '').slice(0, 12), 16)).toBe(Date.UTC(2026, 9, 22, 12))
  })

  it('sorts by time and never repeats', () => {
    const earlier = uuid7(1_000)
    const later = uuid7(2_000)
    const many = new Set(Array.from({ length: 1000 }, () => uuid7(5_000)))

    expect(earlier < later).toBe(true)
    expect(many.size).toBe(1000)
  })
})
