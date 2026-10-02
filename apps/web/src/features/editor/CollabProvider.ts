import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'
import { ApiError } from '../../lib/api'
import type { Role } from '../documents/api'

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
/** One byte, echoed by the server; see the heartbeat comment below. */
const MESSAGE_HEARTBEAT = 120

/**
 * Some proxies (Render's edge, for one) do not forward the server's close frame: the socket stays
 * "open" until the client happens to send something, and even then ends as 1006 seconds later.
 * Browsers cannot send WebSocket pings, so the client sends a heartbeat the server echoes, and
 * gives up on a socket when a heartbeat stays unanswered. Without it an idle reader could sit
 * "online" forever after a deploy, receiving nothing.
 *
 * The test is "unanswered", not "nothing heard lately": Chrome may run a hidden tab's timers only
 * once a minute, and judging by silence would then reconnect every minute for no reason. The
 * heartbeats also keep the server's idle timeout from closing a quiet but live reader.
 */
const HEARTBEAT_INTERVAL_MS = 15_000
const UNANSWERED_LIMIT_MS = 25_000

/** Close codes sent by the server; see app/collab/room.py. */
export const CloseCode = {
  restarting: 1012,
  silent: 4000, // either side heard nothing for too long; reconnect
  badMessage: 4400,
  invalidTicket: 4401,
  forbidden: 4403,
  notFound: 4404,
  tooSlow: 4408,
  roleChanged: 4409,
  rateLimited: 4429,
} as const

export type ConnectionStatus = 'connecting' | 'online' | 'offline' | 'stopped'
export type StopReason = 'forbidden' | 'not_found' | 'signed_out' | 'rejected'

export interface Peer {
  clientId: number
  name: string
  color: string
  self: boolean
}

export interface CollabState {
  status: ConnectionStatus
  /** True once this session has received the server's copy of the document. */
  synced: boolean
  /** True once the offline copy has loaded, so the editor can show content without the server. */
  localReady: boolean
  /** Local edits the server has not received yet. */
  unsynced: number
  role: Role | null
  stopReason: StopReason | null
  peers: Peer[]
}

export interface LocalStore {
  whenSynced: Promise<unknown>
  clearData(): Promise<void>
  destroy(): Promise<void>
}

export interface CollabDeps {
  getTicket(documentId: string): Promise<{ ticket: string; role: Role }>
  socketUrl(documentId: string, ticket: string): string
  openLocalStore(doc: Y.Doc): LocalStore | null
  createSocket?: (url: string) => WebSocket
  random?: () => number
}

const MAX_BACKOFF_MS = 30_000

/**
 * Keeps a Yjs document in sync with the server over one WebSocket, and with an offline copy in
 * IndexedDB. Unlike y-websocket's provider it fetches a fresh one-time ticket for every
 * connection attempt and acts on the server's close codes.
 */
export class CollabProvider {
  readonly documentId: string
  /** The guid is the document id, which also names the offline copy. */
  readonly doc: Y.Doc
  readonly awareness: awarenessProtocol.Awareness

  private state: CollabState = {
    status: 'connecting',
    synced: false,
    localReady: false,
    unsynced: 0,
    role: null,
    stopReason: null,
    peers: [],
  }
  private readonly listeners = new Set<() => void>()
  private socket: WebSocket | null = null
  private attempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  /** When the oldest heartbeat still waiting for any reply was sent; null when none is. */
  private unansweredSince: number | null = null
  /** Bumped by every connect and stop: a connect that resumes after a newer one, or after a
   * stop, must not open a second socket nobody would ever close. */
  private generation = 0
  private local: LocalStore | null = null
  private running = false
  private readonly deps: Required<CollabDeps>

  constructor(documentId: string, deps: CollabDeps) {
    this.documentId = documentId
    this.doc = new Y.Doc({ guid: documentId })
    this.awareness = new awarenessProtocol.Awareness(this.doc)
    this.deps = {
      createSocket: (url) => new WebSocket(url),
      random: Math.random,
      ...deps,
    }
  }

  // ----- public API ---------------------------------------------------------------------------

  /** Opens the offline copy and connects. Safe to call again after stop(). */
  start(): void {
    if (this.running) return
    this.running = true
    this.attempts = 0
    if (this.state.status !== 'stopped') this.update({ status: 'connecting' })
    this.local = this.deps.openLocalStore(this.doc)
    void this.local?.whenSynced.then(() => this.update({ localReady: true }))
    if (!this.local) this.update({ localReady: true })

    this.doc.on('update', this.onDocUpdate)
    this.awareness.on('update', this.onAwarenessUpdate)
    this.awareness.on('change', this.onAwarenessChange)
    globalThis.addEventListener?.('online', this.onBrowserOnline)
    globalThis.addEventListener?.('offline', this.onBrowserOffline)
    void this.connect()
  }

  /** Disconnects and closes the offline copy; the document stays in memory for a restart. */
  stop(): void {
    if (!this.running) return
    this.running = false
    this.generation += 1
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.stopHeartbeat()
    globalThis.removeEventListener?.('online', this.onBrowserOnline)
    globalThis.removeEventListener?.('offline', this.onBrowserOffline)
    // Tell others our cursor is gone before the socket closes.
    const user = this.awareness.getLocalState()?.user as unknown
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'stop')
    this.awareness.off('update', this.onAwarenessUpdate)
    this.awareness.off('change', this.onAwarenessChange)
    this.doc.off('update', this.onDocUpdate)
    const socket = this.socket
    this.socket = null
    socket?.close(1000, 'Closed')
    void this.local?.destroy()
    this.local = null
    // Restore our own presence for a later start().
    if (user) this.awareness.setLocalState({ user })
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): CollabState => this.state

  setUser(user: { name: string; color: string }): void {
    this.awareness.setLocalStateField('user', user)
  }

  // ----- connection lifecycle -----------------------------------------------------------------

  private async connect(): Promise<void> {
    if (!this.running || this.socket || this.state.status === 'stopped') return
    const generation = ++this.generation
    this.update({ status: 'connecting' })

    let grant: { ticket: string; role: Role }
    try {
      grant = await this.deps.getTicket(this.documentId)
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return this.halt('not_found')
      if (error instanceof ApiError && error.status === 403) return this.halt('forbidden')
      if (error instanceof ApiError && error.status === 401) return this.halt('signed_out')
      if (generation !== this.generation) return
      return this.scheduleReconnect() // offline or server down: keep editing locally, retry
    }
    // While the ticket was on its way, the provider may have stopped (and even started again,
    // as React does in development) or another connect may have begun: that one wins.
    if (!this.running || generation !== this.generation || this.socket) return
    this.update({ role: grant.role })
    const ticket = grant.ticket

    const socket = this.deps.createSocket(this.deps.socketUrl(this.documentId, ticket))
    socket.binaryType = 'arraybuffer'
    this.socket = socket

    socket.onopen = () => {
      this.attempts = 0
      this.update({ status: 'online' })
      this.startHeartbeat(socket)
      // Our state vector; the server answers with every update we lack.
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      syncProtocol.writeSyncStep1(encoder, this.doc)
      this.send(encoding.toUint8Array(encoder))
      if (this.awareness.getLocalState() !== null) this.sendAwareness([this.doc.clientID])
    }
    socket.onmessage = (event: MessageEvent) => {
      this.unansweredSince = null // anything at all proves the connection works
      this.receive(new Uint8Array(event.data as ArrayBuffer))
    }
    socket.onclose = (event: CloseEvent) => this.dropSocket(socket, event.code)
  }

  /** The one path for "this socket is gone", whether it closed or went silent. */
  private dropSocket(socket: WebSocket, code: number): void {
    if (this.socket !== socket) return
    this.socket = null
    this.stopHeartbeat()
    // Everyone else's cursor is unknown until we reconnect.
    const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID)
    awarenessProtocol.removeAwarenessStates(this.awareness, others, 'disconnect')
    this.update({ synced: false })
    this.handleClose(code)
  }

  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat()
    this.unansweredSince = null
    this.heartbeat = setInterval(() => {
      const now = Date.now()
      if (this.unansweredSince !== null && now - this.unansweredSince > UNANSWERED_LIMIT_MS) {
        // Do not wait for a close event a proxy may never deliver: reconnect now. The fresh
        // ticket request also tells us if access was removed while we were cut off.
        socket.onclose = null
        socket.close(CloseCode.silent, 'No heartbeat')
        this.dropSocket(socket, CloseCode.silent)
        return
      }
      this.unansweredSince ??= now
      this.send(new Uint8Array([MESSAGE_HEARTBEAT]))
    }, HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  private handleClose(code: number): void {
    if (!this.running) return
    switch (code) {
      case CloseCode.forbidden:
        return this.halt('forbidden')
      case CloseCode.notFound:
        return this.halt('not_found')
      case CloseCode.badMessage:
        return this.halt('rejected')
      case CloseCode.roleChanged:
        // Someone changed our access; a fresh ticket carries the new role.
        this.attempts = 0
        return this.scheduleReconnect(0)
      case CloseCode.invalidTicket:
        // Expired between issue and use; a fresh ticket usually fixes it, but not forever.
        return this.attempts < 3 ? this.scheduleReconnect(0) : this.scheduleReconnect()
      default:
        return this.scheduleReconnect()
    }
  }

  private scheduleReconnect(delayMs?: number): void {
    if (!this.running || this.state.status === 'stopped') return
    this.update({ status: 'offline' })
    // Exponential backoff with jitter, so a restarted server is not hit by everyone at once.
    const backoff = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempts)
    const delay = delayMs ?? backoff * (0.5 + this.deps.random() / 2)
    this.attempts += 1
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
  }

  /** Stops for good: access or the document is gone. */
  private halt(reason: StopReason): void {
    this.update({ status: 'stopped', stopReason: reason, synced: false })
    this.stopHeartbeat()
    this.socket?.close(1000, 'Stopped')
    this.socket = null
    // Access is gone: the offline copy must not outlive it.
    if (reason === 'forbidden' || reason === 'not_found') void this.local?.clearData()
  }

  // ----- messages -----------------------------------------------------------------------------

  private receive(message: Uint8Array): void {
    const decoder = decoding.createDecoder(message)
    const type = decoding.readVarUint(decoder)
    if (type === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      const step = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this)
      if (encoding.length(encoder) > 1) {
        // We just answered the server's step 1 with everything it lacks: offline edits included.
        this.send(encoding.toUint8Array(encoder))
        this.update({ unsynced: 0 })
      }
      if (step === syncProtocol.messageYjsSyncStep2 && !this.state.synced) {
        this.update({ synced: true })
      }
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        this.awareness,
        decoding.readVarUint8Array(decoder),
        this,
      )
    }
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this) return // came from the server
    if (this.socket?.readyState === WebSocket.OPEN) {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      syncProtocol.writeUpdate(encoder, update)
      this.send(encoding.toUint8Array(encoder))
    } else if (this.local && origin !== this.local) {
      // Kept in IndexedDB and delivered by the next handshake.
      this.update({ unsynced: this.state.unsynced + 1 })
    }
  }

  private onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === this || origin === 'disconnect') return
    const changed = [...added, ...updated, ...removed].filter((id) => id === this.doc.clientID)
    if (changed.length) this.sendAwareness(changed)
  }

  private onAwarenessChange = (): void => {
    const peers: Peer[] = []
    this.awareness.getStates().forEach((state, clientId) => {
      const user = (state as { user?: { name?: unknown; color?: unknown } }).user
      if (!user || typeof user.name !== 'string') return
      peers.push({
        clientId,
        name: user.name,
        color: typeof user.color === 'string' ? user.color : '#64748b',
        self: clientId === this.doc.clientID,
      })
    })
    this.update({ peers })
  }

  private sendAwareness(clientIds: number[]): void {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, clientIds),
    )
    this.send(encoding.toUint8Array(encoder))
  }

  private send(message: Uint8Array): void {
    // lib0 types its buffers as ArrayBufferLike; they are always plain ArrayBuffers.
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(message as Uint8Array<ArrayBuffer>)
  }

  private onBrowserOnline = (): void => {
    if (this.socket || this.state.status === 'stopped') return
    this.attempts = 0
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    void this.connect()
  }

  private onBrowserOffline = (): void => {
    // The socket may take a while to notice; close it so edits count as unsynced right away.
    this.socket?.close(4000, 'Browser offline')
  }

  private update(patch: Partial<CollabState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
}
