import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'
import { ApiError } from '../../lib/api'
import { CloseCode, CollabProvider, type CollabDeps, type LocalStore } from './CollabProvider'

class FakeSocket {
  static all: FakeSocket[] = []
  readonly url: string
  readyState = 0
  binaryType = 'blob'
  sent: Uint8Array[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeSocket.all.push(this)
  }

  send(data: Uint8Array) {
    this.sent.push(new Uint8Array(data))
  }

  close(code = 1000) {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.({ code })
  }

  // Test controls
  open() {
    this.readyState = 1
    this.onopen?.()
  }

  deliver(message: Uint8Array) {
    this.onmessage?.({ data: message.slice().buffer })
  }

  serverClose(code: number) {
    this.readyState = 3
    this.onclose?.({ code })
  }
}

/** A tiny in-memory stand-in for the sync server, speaking the real Yjs protocol. */
class FakeServer {
  readonly doc = new Y.Doc()

  /** What the server does when a client joins: send its state vector (sync step 1). */
  greet(socket: FakeSocket) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, 0)
    syncProtocol.writeSyncStep1(encoder, this.doc)
    socket.deliver(encoding.toUint8Array(encoder))
  }

  /** Processes everything the client sent since the last call, replying like the server. */
  pump(socket: FakeSocket) {
    const messages = socket.sent.splice(0)
    for (const message of messages) {
      const decoder = decoding.createDecoder(message)
      if (decoding.readVarUint(decoder) !== 0) continue
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, 0)
      syncProtocol.readSyncMessage(decoder, encoder, this.doc, 'client')
      if (encoding.length(encoder) > 1) socket.deliver(encoding.toUint8Array(encoder))
    }
  }

  text() {
    return this.doc.getText('body').toString()
  }
}

function fakeLocalStore(): LocalStore & { clearData: ReturnType<typeof vi.fn> } {
  return {
    whenSynced: Promise.resolve(),
    clearData: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
  }
}

function setup(overrides: Partial<CollabDeps> = {}) {
  const local = fakeLocalStore()
  let ticketNumber = 0
  const deps: CollabDeps = {
    getTicket: vi.fn(async () => ({ ticket: `ticket-${++ticketNumber}`, role: 'editor' as const })),
    socketUrl: (id, ticket) => `ws://test/api/ws/docs/${id}?ticket=${ticket}`,
    openLocalStore: () => local,
    createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
    random: () => 0,
    ...overrides,
  }
  const provider = new CollabProvider('doc-1', deps)
  provider.setUser({ name: 'Ada', color: '#123456' })
  return { provider, deps, local, server: new FakeServer() }
}

const lastSocket = () => FakeSocket.all.at(-1)!
const flush = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  FakeSocket.all = []
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('CollabProvider', () => {
  it('connects with a fresh ticket and opens with its state vector', async () => {
    const { provider, deps } = setup()

    provider.start()
    await flush()
    lastSocket().open()

    expect(deps.getTicket).toHaveBeenCalledWith('doc-1')
    expect(lastSocket().url).toBe('ws://test/api/ws/docs/doc-1?ticket=ticket-1')
    const first = decoding.createDecoder(lastSocket().sent[0])
    expect(decoding.readVarUint(first)).toBe(0) // sync
    expect(decoding.readVarUint(first)).toBe(syncProtocol.messageYjsSyncStep1)
    expect(provider.getSnapshot()).toMatchObject({ status: 'online', role: 'editor' })
    provider.stop()
  })

  it('downloads the server copy and sends local edits', async () => {
    const { provider, server } = setup()
    server.doc.getText('body').insert(0, 'Hello')

    provider.start()
    await flush()
    const socket = lastSocket()
    socket.open()
    server.greet(socket)
    server.pump(socket)

    expect(provider.doc.getText('body').toString()).toBe('Hello')
    expect(provider.getSnapshot().synced).toBe(true)

    provider.doc.getText('body').insert(5, ', world')
    server.pump(socket)
    expect(server.text()).toBe('Hello, world')
    provider.stop()
  })

  it('counts offline edits and delivers them in the next handshake', async () => {
    const getTicket = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch')) // offline
      .mockResolvedValue({ ticket: 'later', role: 'editor' })
    const { provider, server } = setup({ getTicket })

    provider.start()
    await flush()
    expect(provider.getSnapshot().status).toBe('offline')

    provider.doc.getText('body').insert(0, 'written offline')
    provider.doc.getText('body').insert(0, '> ')
    expect(provider.getSnapshot().unsynced).toBe(2)

    await vi.advanceTimersByTimeAsync(1_000) // backoff elapses, connection returns
    const socket = lastSocket()
    socket.open()
    server.greet(socket) // server asks for what it lacks...
    server.pump(socket)

    expect(server.text()).toBe('> written offline') // ...and receives the offline edits
    expect(provider.getSnapshot()).toMatchObject({ unsynced: 0, synced: true })
    provider.stop()
  })

  it('backs off exponentially and fetches a new ticket for each attempt', async () => {
    const { provider, deps } = setup()
    provider.start()
    await flush()

    lastSocket().serverClose(CloseCode.restarting)
    expect(provider.getSnapshot().status).toBe('offline')
    await vi.advanceTimersByTimeAsync(249)
    expect(deps.getTicket).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1) // 500ms backoff, halved by zero jitter
    expect(deps.getTicket).toHaveBeenCalledTimes(2)

    lastSocket().serverClose(CloseCode.tooSlow)
    await vi.advanceTimersByTimeAsync(499)
    expect(deps.getTicket).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1) // doubled
    expect(deps.getTicket).toHaveBeenCalledTimes(3)
    expect(lastSocket().url).toContain('ticket-3')
    provider.stop()
  })

  it('retries at once when a ticket was refused', async () => {
    const { provider, deps } = setup()
    provider.start()
    await flush()

    lastSocket().serverClose(CloseCode.invalidTicket)
    await flush()

    expect(deps.getTicket).toHaveBeenCalledTimes(2)
    provider.stop()
  })

  it('reconnects at once with a new ticket when its role changes', async () => {
    const getTicket = vi
      .fn()
      .mockResolvedValueOnce({ ticket: 'as-editor', role: 'editor' })
      .mockResolvedValueOnce({ ticket: 'as-viewer', role: 'viewer' })
    const { provider } = setup({ getTicket })
    provider.start()
    await flush()
    lastSocket().open()

    lastSocket().serverClose(CloseCode.roleChanged)
    await flush()

    expect(getTicket).toHaveBeenCalledTimes(2)
    expect(lastSocket().url).toContain('as-viewer')
    expect(provider.getSnapshot().role).toBe('viewer')
    provider.stop()
  })

  it.each([
    [CloseCode.forbidden, 'forbidden'],
    [CloseCode.notFound, 'not_found'],
  ])('stops and deletes the offline copy on close code %i', async (code, reason) => {
    const { provider, deps, local } = setup()
    provider.start()
    await flush()

    lastSocket().serverClose(code)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(provider.getSnapshot()).toMatchObject({ status: 'stopped', stopReason: reason })
    expect(local.clearData).toHaveBeenCalledOnce()
    expect(deps.getTicket).toHaveBeenCalledOnce() // no reconnect attempts
    provider.stop()
  })

  it('stops without a connection when the ticket request says the document is gone', async () => {
    const getTicket = vi.fn().mockRejectedValue(new ApiError(404, 'document_not_found', '', null))
    const { provider, local } = setup({ getTicket })

    provider.start()
    await flush()

    expect(provider.getSnapshot()).toMatchObject({ status: 'stopped', stopReason: 'not_found' })
    expect(local.clearData).toHaveBeenCalledOnce()
    expect(FakeSocket.all).toHaveLength(0)
    provider.stop()
  })

  it('shows who else is here and forgets them on disconnect', async () => {
    const { provider } = setup()
    provider.start()
    await flush()
    const socket = lastSocket()
    socket.open()

    const remote = new awarenessProtocol.Awareness(new Y.Doc())
    remote.setLocalState({ user: { name: 'Grace', color: '#ff0000' } })
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, 1)
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(remote, [remote.clientID]),
    )
    socket.deliver(encoding.toUint8Array(encoder))

    expect(provider.getSnapshot().peers.map((peer) => [peer.name, peer.self])).toEqual([
      ['Ada', true],
      ['Grace', false],
    ])

    socket.serverClose(CloseCode.restarting)
    expect(provider.getSnapshot().peers.map((peer) => peer.name)).toEqual(['Ada'])
    provider.stop()
  })

  it('tells comment listeners when the server says comments changed', async () => {
    const { provider } = setup()
    const heard = vi.fn()
    const unsubscribe = provider.onCommentsChanged(heard)
    provider.start()
    await flush()
    lastSocket().open()

    lastSocket().deliver(new Uint8Array([121]))
    unsubscribe()
    lastSocket().deliver(new Uint8Array([121]))

    expect(heard).toHaveBeenCalledTimes(1)
    provider.stop()
  })

  it('sends a heartbeat every 15 seconds while connected', async () => {
    const { provider } = setup()
    provider.start()
    await flush()
    const socket = lastSocket()
    socket.open()
    socket.sent.length = 0

    await vi.advanceTimersByTimeAsync(15_000)

    expect(socket.sent).toEqual([new Uint8Array([120])])
    provider.stop()
  })

  it('reconnects when the server goes silent, even if no close event ever arrives', async () => {
    // What Render's proxy does: the server has closed its side, the client socket stays "open".
    const { provider, deps } = setup()
    provider.start()
    await flush()
    const dead = lastSocket()
    dead.open()

    await vi.advanceTimersByTimeAsync(30_000) // two heartbeats, no answer, still within the limit
    expect(deps.getTicket).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15_000) // 45 s of silence: give up on this socket
    expect(dead.readyState).toBe(3)
    expect(provider.getSnapshot().status).toBe('offline')
    await vi.advanceTimersByTimeAsync(250) // backoff, then a fresh ticket

    expect(deps.getTicket).toHaveBeenCalledTimes(2)
    expect(lastSocket()).not.toBe(dead)
    provider.stop()
  })

  it('stays connected while heartbeats are answered', async () => {
    const { provider, deps } = setup()
    provider.start()
    await flush()
    const socket = lastSocket()
    socket.open()

    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(15_000)
      socket.deliver(new Uint8Array([120])) // the server's echo
    }

    expect(deps.getTicket).toHaveBeenCalledTimes(1)
    expect(provider.getSnapshot().status).toBe('online')
    provider.stop()
  })

  it('does not reconnect when a hidden tab runs its timers only once a minute', async () => {
    const { provider, deps } = setup()
    provider.start()
    await flush()
    const socket = lastSocket()
    socket.open()

    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(15_000) // a heartbeat goes out...
      socket.deliver(new Uint8Array([120])) // ...and is answered
      vi.setSystemTime(Date.now() + 60_000) // then the browser lets a minute pass, timers asleep
    }
    await vi.advanceTimersByTimeAsync(15_000)

    expect(deps.getTicket).toHaveBeenCalledTimes(1)
    expect(socket.readyState).toBe(1)
    provider.stop()
  })

  it('never leaves a socket open when stopped and restarted while fetching a ticket', async () => {
    // React's development double mount: start, stop, start, all before the ticket arrives.
    const { provider } = setup()

    provider.start()
    provider.stop()
    provider.start()
    await flush()
    lastSocket().open()

    const open = FakeSocket.all.filter((socket) => socket.readyState !== 3)
    expect(open).toHaveLength(1)
    provider.stop()
    expect(FakeSocket.all.every((socket) => socket.readyState === 3)).toBe(true)
  })

  it('can stop and start again, as React does in development', async () => {
    const { provider } = setup()

    provider.start()
    await flush()
    provider.stop()
    provider.start()
    await flush()
    lastSocket().open()

    expect(FakeSocket.all).toHaveLength(2)
    expect(FakeSocket.all[0].readyState).toBe(3)
    expect(provider.getSnapshot().status).toBe('online')
    expect(provider.awareness.getLocalState()).toEqual({ user: { name: 'Ada', color: '#123456' } })
    provider.stop()
  })
})
