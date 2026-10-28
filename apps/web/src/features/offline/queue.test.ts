import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../lib/api'
import { MemoryStore, Outbox, type OutboxEntry } from '../../lib/outbox'
import { sendOrQueue, whenOnServer } from './queue'

const rename: Omit<OutboxEntry, 'createdAt'> = {
  kind: 'rename',
  documentId: 'd1',
  method: 'PATCH',
  path: '/documents/d1',
  body: { title: 'New' },
  label: 'Rename',
}

function outboxSending(send: (entry: OutboxEntry) => Promise<unknown>) {
  return new Outbox(new MemoryStore(), {
    send,
    // Retries are this test's business, not a timer's.
    setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => {},
  })
}

describe('sendOrQueue', () => {
  it('sends at once when the API answers, and queues nothing', async () => {
    const outbox = outboxSending(async () => ({}))
    const send = vi.fn(async () => 'renamed')

    expect(await sendOrQueue(outbox, rename, send)).toEqual({ queued: false, result: 'renamed' })
    expect(outbox.getSnapshot().entries).toEqual([])
  })

  it('queues the change when the API cannot be reached', async () => {
    const outbox = outboxSending(async () => Promise.reject(new TypeError('Failed to fetch')))

    const sent = await sendOrQueue(outbox, rename, async () => Promise.reject(new TypeError('x')))

    expect(sent).toEqual({ queued: true })
    expect(outbox.getSnapshot().entries).toMatchObject([{ kind: 'rename', label: 'Rename' }])
  })

  it('lets the server’s own refusals through, unqueued', async () => {
    const outbox = outboxSending(async () => ({}))
    const refused = new ApiError(403, 'insufficient_role', 'No', null)

    await expect(sendOrQueue(outbox, rename, async () => Promise.reject(refused))).rejects.toBe(
      refused,
    )
    expect(outbox.getSnapshot().entries).toEqual([])
  })

  it('queues changes to a document the server has not heard of yet behind its creation', async () => {
    const sent: string[] = []
    let reachable = false
    const outbox = outboxSending(async (entry) => {
      if (!reachable) throw new TypeError('Failed to fetch')
      sent.push(entry.kind)
    })
    await outbox.add({ ...rename, kind: 'create', method: 'PUT', label: 'Create', createdAt: 0 })
    const direct = vi.fn(async () => 'not used')

    // Even with the API back, the rename must not overtake the creation.
    reachable = true
    expect(await sendOrQueue(outbox, rename, direct)).toEqual({ queued: true })
    await outbox.flush()

    expect(direct).not.toHaveBeenCalled()
    expect(sent).toEqual(['create', 'rename'])
  })
})

describe('whenOnServer', () => {
  it('sends a pending creation first, and says "offline" when it cannot', async () => {
    let reachable = false
    const outbox = outboxSending(async () => {
      if (!reachable) throw new TypeError('Failed to fetch')
    })
    await outbox.add({ ...rename, kind: 'create', method: 'PUT', label: 'Create', createdAt: 0 })

    // A TypeError, like fetch without a network: retried later, never read as "not found".
    await expect(whenOnServer(outbox, 'd1')).rejects.toBeInstanceOf(TypeError)

    reachable = true
    await expect(whenOnServer(outbox, 'd1')).resolves.toBeUndefined()
    expect(outbox.isPendingCreate('d1')).toBe(false)
    await expect(whenOnServer(null, 'anything')).resolves.toBeUndefined()
  })
})
