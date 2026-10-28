import { ApiError } from './api'
import { describeError } from './errors'
import { isUnreachable } from './network'

export type OutboxKind = 'create' | 'rename' | 'star' | 'thread' | 'reply'

/** One change made while the API was out of reach, waiting to be sent. */
export interface OutboxEntry {
  /** Storage key; increasing, so it is also the order the changes were made in. */
  seq?: number
  kind: OutboxKind
  documentId: string
  method: 'PUT' | 'PATCH' | 'POST' | 'DELETE'
  path: string
  body?: unknown
  /** A later entry with the same key makes this one pointless (a newer title, star state). */
  supersedes?: string
  /** For a reply: the thread it answers. */
  threadId?: string
  /** What the person did, for the notice shown if the server refuses it. */
  label: string
  createdAt: number
}

/** Something made offline that the server refused once it could be asked. */
export interface OutboxFailure {
  id: string
  /** What the person did, as they would name it. */
  label: string
  /** Why the server refused it. */
  message: string
}

export interface OutboxSnapshot {
  entries: OutboxEntry[]
  failures: OutboxFailure[]
}

/** Where entries are kept: IndexedDB in browsers, memory where there is none (tests). */
export interface OutboxStore {
  all(): Promise<OutboxEntry[]>
  add(entry: OutboxEntry): Promise<number>
  remove(seq: number): Promise<void>
  close(): void
}

/** The session ended (the refresh cookie is gone): keep the entries for the next sign-in. */
export class SessionEnded extends Error {
  constructor() {
    super('Signed out')
    this.name = 'SessionEnded'
  }
}

export interface OutboxDeps {
  send(entry: OutboxEntry): Promise<unknown>
  /** The server accepted an entry and answered with `result`; called as it leaves the queue. */
  onSent?(entry: OutboxEntry, result: unknown): void
  /** After the server accepted or refused an entry: refresh what it touched. */
  onSettled?(entry: OutboxEntry): void
  /** Serialises flushing across tabs (Web Locks); without it, only within this tab. */
  exclusive?: <T>(run: () => Promise<T>) => Promise<T>
  /** Tells other tabs the queue changed, and hears when theirs did. */
  channel?: { post(): void; listen(onChange: () => void): () => void }
  setTimer?: (run: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

const FIRST_RETRY_MS = 2_000
const MAX_RETRY_MS = 60_000

/**
 * Changes made while offline, replayed in order once the API answers again (ADR 0019).
 *
 * Every request the outbox sends is safe to repeat: documents are created with an id the
 * browser chose (PUT), comments carry a client id, renames and stars set a value. So a reply lost
 * on the way back, or two tabs sending the same entry, can never duplicate anything.
 */
export class Outbox {
  private snapshot: OutboxSnapshot = { entries: [], failures: [] }
  private readonly listeners = new Set<() => void>()
  private flushing: Promise<void> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryDelay = FIRST_RETRY_MS
  private readonly loaded: Promise<void>
  private readonly unlisten: () => void
  private closed = false
  private readonly store: OutboxStore
  private readonly deps: OutboxDeps

  constructor(store: OutboxStore, deps: OutboxDeps) {
    this.store = store
    this.deps = deps
    this.loaded = this.reload()
    this.unlisten = deps.channel?.listen(() => void this.reload()) ?? (() => {})
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): OutboxSnapshot => this.snapshot

  /** Resolves once the entries saved by earlier visits are loaded. */
  ready(): Promise<void> {
    return this.loaded
  }

  async add(entry: OutboxEntry): Promise<void> {
    await this.loaded
    const seq = await this.store.add(entry)
    this.set({ entries: [...this.snapshot.entries, { ...entry, seq }] })
    this.deps.channel?.post()
  }

  /** Whether the server has yet to hear that this document exists. */
  isPendingCreate(documentId: string): boolean {
    return this.snapshot.entries.some((e) => e.kind === 'create' && e.documentId === documentId)
  }

  dismissFailures(): void {
    this.set({ failures: [] })
  }

  /** Reports a refusal from outside the queue (a document's offline edits, ADR 0019). */
  reportFailure(label: string, message: string): void {
    const failure = { id: `report-${Date.now()}-${this.snapshot.failures.length}`, label, message }
    this.set({ failures: [...this.snapshot.failures, failure] })
  }

  /** Sends everything waiting, oldest first. Concurrent calls share one run. */
  flush(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.flushing ??= this.runExclusively().finally(() => {
      this.flushing = null
    })
    return this.flushing
  }

  close(): void {
    this.closed = true
    if (this.retryTimer) (this.deps.clearTimer ?? clearTimeout)(this.retryTimer)
    this.unlisten()
    this.store.close()
  }

  private runExclusively(): Promise<void> {
    const run = () => this.drain()
    return this.deps.exclusive ? this.deps.exclusive(run) : run()
  }

  private async drain(): Promise<void> {
    await this.loaded
    // Another tab may have sent some of these while we waited for the lock.
    await this.reload()
    // Always the oldest entry still waiting, so changes made during the run are sent too.
    for (let entry = this.snapshot.entries[0]; entry; entry = this.snapshot.entries[0]) {
      if (this.closed) return
      if (this.isSuperseded(entry)) {
        await this.forget(entry)
        continue
      }
      try {
        const result = await this.deps.send(entry)
        this.deps.onSent?.(entry, result)
      } catch (error) {
        if (error instanceof SessionEnded || isSignedOut(error)) return // kept for the next sign-in
        if (isWorthRetrying(error)) return this.retryLater()
        // The server refused it (gone, no access, invalid): retrying cannot help. Say so.
        const failure = { id: String(entry.seq), label: entry.label, message: describeError(error) }
        this.set({ failures: [...this.snapshot.failures, failure] })
      }
      await this.forget(entry)
      this.deps.onSettled?.(entry)
      this.retryDelay = FIRST_RETRY_MS
    }
  }

  private isSuperseded(entry: OutboxEntry): boolean {
    if (!entry.supersedes) return false
    return this.snapshot.entries.some(
      (later) => later.supersedes === entry.supersedes && (later.seq ?? 0) > (entry.seq ?? 0),
    )
  }

  private async forget(entry: OutboxEntry): Promise<void> {
    // Off the screen in the same moment onSent shows the server's copy. Should the delete
    // below fail, the next visit sends the entry again, which every request here allows.
    this.set({ entries: this.snapshot.entries.filter((e) => e.seq !== entry.seq) })
    if (entry.seq !== undefined) await this.store.remove(entry.seq)
    this.deps.channel?.post()
  }

  private retryLater(): void {
    if (this.retryTimer || this.closed) return
    const delay = this.retryDelay
    this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_MS)
    this.retryTimer = (this.deps.setTimer ?? setTimeout)(() => {
      this.retryTimer = null
      void this.flush()
    }, delay)
  }

  private async reload(): Promise<void> {
    const entries = await this.store.all()
    if (this.closed) return
    // Unchanged (the usual case, on every retry): keep the snapshot, so nothing re-renders.
    const seqs = (list: OutboxEntry[]) => list.map((entry) => entry.seq).join()
    if (seqs(entries) !== seqs(this.snapshot.entries)) this.set({ entries })
  }

  private set(patch: Partial<OutboxSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }
}

function isSignedOut(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401
}

/** Out of reach, rate limited or failing for now: the same request may well succeed later. */
function isWorthRetrying(error: unknown): boolean {
  if (isUnreachable(error)) return true
  return error instanceof ApiError && (error.status === 429 || error.status >= 500)
}

// ----- stores -------------------------------------------------------------------------------------

export class MemoryStore implements OutboxStore {
  private rows: OutboxEntry[] = []
  private next = 1

  async all(): Promise<OutboxEntry[]> {
    return [...this.rows]
  }

  async add(entry: OutboxEntry): Promise<number> {
    const seq = this.next++
    this.rows.push({ ...entry, seq })
    return seq
  }

  async remove(seq: number): Promise<void> {
    this.rows = this.rows.filter((row) => row.seq !== seq)
  }

  close(): void {}
}

const STORE = 'entries'

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export class IndexedDbStore implements OutboxStore {
  private readonly db: Promise<IDBDatabase>

  constructor(name: string) {
    this.db = new Promise((resolve, reject) => {
      const open = indexedDB.open(name, 1)
      open.onupgradeneeded = () =>
        open.result.createObjectStore(STORE, { keyPath: 'seq', autoIncrement: true })
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
      // Signing out deletes this database; let that happen even while a tab holds it open.
      open.onblocked = () => reject(new Error('Outbox database blocked'))
    })
    void this.db.then((db) => {
      db.onversionchange = () => db.close()
    })
  }

  async all(): Promise<OutboxEntry[]> {
    const db = await this.db
    return request(db.transaction(STORE).objectStore(STORE).getAll() as IDBRequest<OutboxEntry[]>)
  }

  async add(entry: OutboxEntry): Promise<number> {
    const db = await this.db
    const { seq: _ignored, ...row } = entry
    return Number(await request(db.transaction(STORE, 'readwrite').objectStore(STORE).add(row)))
  }

  async remove(seq: number): Promise<void> {
    const db = await this.db
    await request(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(seq))
  }

  close(): void {
    void this.db.then((db) => db.close()).catch(() => {})
  }
}
