import { describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import { MemoryStore, Outbox, SessionEnded, type OutboxEntry } from './outbox'

function entry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    kind: 'rename',
    documentId: 'doc-1',
    method: 'PATCH',
    path: '/documents/doc-1',
    body: { title: 'New title' },
    label: 'Rename',
    createdAt: 0,
    ...overrides,
  }
}

const offline = () => new TypeError('Failed to fetch')
const refused = (status: number) => new ApiError(status, 'nope', 'Refused by the server', null)

/** An outbox whose sends a test scripts, and whose retry timer a test fires by hand. */
function setup(send: (entry: OutboxEntry) => Promise<unknown> = async () => ({})) {
  const sent: string[] = []
  const settled: string[] = []
  const timers: (() => void)[] = []
  const outbox = new Outbox(new MemoryStore(), {
    send: vi.fn(async (e: OutboxEntry) => {
      const result = await send(e)
      sent.push(e.label)
      return result
    }),
    onSettled: (e) => settled.push(e.label),
    setTimer: (run) => {
      timers.push(run)
      return 0 as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: () => {},
  })
  return { outbox, sent, settled, timers }
}

describe('outbox', () => {
  it('sends changes in the order they were made, once each', async () => {
    const { outbox, sent, settled } = setup()
    await outbox.add(entry({ kind: 'create', label: 'Create' }))
    await outbox.add(entry({ label: 'Rename' }))
    await outbox.add(entry({ kind: 'thread', label: 'Comment' }))

    await outbox.flush()
    await outbox.flush()

    expect(sent).toEqual(['Create', 'Rename', 'Comment'])
    expect(settled).toEqual(['Create', 'Rename', 'Comment'])
    expect(outbox.getSnapshot().entries).toEqual([])
  })

  it('keeps everything while the API is out of reach and retries with backoff', async () => {
    let reachable = false
    const { outbox, sent, timers } = setup(async () => {
      if (!reachable) throw offline()
      return {}
    })
    await outbox.add(entry({ label: 'First' }))
    await outbox.add(entry({ label: 'Second' }))

    await outbox.flush()
    expect(sent).toEqual([])
    expect(outbox.getSnapshot().entries).toHaveLength(2)
    expect(timers).toHaveLength(1)

    reachable = true
    timers[0]()
    await outbox.flush()
    expect(sent).toEqual(['First', 'Second'])
    expect(outbox.getSnapshot().entries).toEqual([])
  })

  it('treats a sleeping server and rate limits as temporary', async () => {
    const errors = [refused(503), refused(429)]
    const { outbox, sent, timers } = setup(async () => {
      const next = errors.shift()
      if (next) throw next
      return {}
    })
    await outbox.add(entry({ label: 'Rename' }))

    await outbox.flush()
    timers.shift()!()
    await outbox.flush()
    timers.shift()!()
    await outbox.flush()

    expect(sent).toEqual(['Rename'])
    expect(outbox.getSnapshot().failures).toEqual([])
  })

  it('drops what the server refuses, says so, and carries on', async () => {
    const { outbox, sent, settled } = setup(async (e) => {
      if (e.label === 'Gone') throw refused(404)
      return {}
    })
    await outbox.add(entry({ label: 'Gone' }))
    await outbox.add(entry({ label: 'Fine' }))

    await outbox.flush()

    expect(sent).toEqual(['Fine'])
    expect(settled).toEqual(['Gone', 'Fine']) // caches refresh after a refusal too
    const [failure] = outbox.getSnapshot().failures
    expect(failure.label).toBe('Gone')
    expect(failure.message).toBe('Refused by the server')
    outbox.dismissFailures()
    expect(outbox.getSnapshot().failures).toEqual([])
  })

  it('sends only the latest of changes that replace each other', async () => {
    const { outbox, sent } = setup()
    await outbox.add(entry({ label: 'Title 1', supersedes: 'title:doc-1' }))
    await outbox.add(entry({ label: 'Star', supersedes: 'star:doc-1' }))
    await outbox.add(entry({ label: 'Title 2', supersedes: 'title:doc-1' }))
    await outbox.add(entry({ label: 'Other doc', supersedes: 'title:doc-2' }))

    await outbox.flush()

    expect(sent).toEqual(['Star', 'Title 2', 'Other doc'])
  })

  it('keeps changes for the next sign-in when the session has ended', async () => {
    for (const error of [new SessionEnded(), refused(401)]) {
      const { outbox, sent, timers } = setup(async () => {
        throw error
      })
      await outbox.add(entry())

      await outbox.flush()

      expect(sent).toEqual([])
      expect(outbox.getSnapshot().entries).toHaveLength(1)
      expect(outbox.getSnapshot().failures).toEqual([])
      expect(timers).toEqual([]) // nothing to retry until someone signs in
    }
  })

  it('sends changes made while it was sending', async () => {
    let added = false
    const holder: { outbox?: Outbox } = {}
    const { outbox, sent } = setup(async () => {
      if (!added) {
        added = true
        await holder.outbox!.add(entry({ label: 'Made meanwhile' }))
      }
      return {}
    })
    holder.outbox = outbox
    await outbox.add(entry({ label: 'First' }))

    await outbox.flush()

    expect(sent).toEqual(['First', 'Made meanwhile'])
  })

  it('runs one flush at a time', async () => {
    const { outbox, sent } = setup()
    await outbox.add(entry({ label: 'Only once' }))

    await Promise.all([outbox.flush(), outbox.flush(), outbox.flush()])

    expect(sent).toEqual(['Only once'])
  })

  it('knows which documents the server has not heard of yet', async () => {
    const { outbox } = setup(async () => {
      throw offline()
    })
    await outbox.add(entry({ kind: 'create', documentId: 'new-doc' }))

    expect(outbox.isPendingCreate('new-doc')).toBe(true)
    expect(outbox.isPendingCreate('doc-1')).toBe(false)
  })

  it("hands over the server's answer in the moment the entry leaves the queue", async () => {
    const seen: { result: unknown; stillQueued: number }[] = []
    const outbox: Outbox = new Outbox(new MemoryStore(), {
      send: async () => ({ id: 'thread-1' }),
      onSent: (_entry, result) =>
        seen.push({ result, stillQueued: outbox.getSnapshot().entries.length }),
    })
    const shown: number[] = []
    outbox.subscribe(() => shown.push(outbox.getSnapshot().entries.length))
    await outbox.add(entry({ kind: 'thread' }))

    await outbox.flush()

    // The answer arrives while the entry is still listed, and the next change removes it: the
    // page can show the server's copy and drop the queued one without a gap.
    expect(seen).toEqual([{ result: { id: 'thread-1' }, stillQueued: 1 }])
    expect(shown.at(-1)).toBe(0)
  })

  it('finds entries saved by an earlier visit', async () => {
    const store = new MemoryStore()
    await store.add(entry({ label: 'From last time' }))
    const sent: string[] = []
    const outbox = new Outbox(store, { send: async (e) => sent.push(e.label) })

    await outbox.ready()
    expect(outbox.getSnapshot().entries).toHaveLength(1)
    await outbox.flush()
    expect(sent).toEqual(['From last time'])
    expect(await store.all()).toEqual([])
  })
})
