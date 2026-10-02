# 0012 · Own sync server on pycrdt, own client provider

- **Status:** accepted
- **Date:** 2026-09-28

## Context

Live editing needs a server that speaks the Yjs sync and awareness protocols. Ready-made options
exist (Hocuspocus in Node, pycrdt-websocket in Python), but they hide the parts this project is
meant to show and do not fit its tickets, roles and persistence model.

## Decision

- **Server** (`app/collab`): FastAPI WebSocket endpoint, one `Room` per open document holding a
  pycrdt `Doc`, managed by a `RoomManager` with a per-document lock. pycrdt handles the CRDT and
  the sync messages; the room adds roles, relaying, batched saving and awareness.
- **Client** (`CollabProvider.ts`): Yjs and y-protocols over a plain WebSocket, with a fresh
  ticket per attempt, exponential backoff with jitter, close-code handling and an IndexedDB copy.

Design points worth defending:

- Each connection has a bounded send queue drained by its own task; a client that falls behind is
  closed (`4408`) instead of slowing everyone else.
- Cleanup after a disconnect runs in a shielded cancel scope and does bookkeeping and saving
  before any network I/O. Without the shield, a cancelled connection task (server shutdown, a
  vanished client) would never release its room or save its edits.
- The server overwrites the name in every awareness state with the ticket's name, so nobody can
  put someone else's name on their cursor.
- Read-only roles may sync (receive) but their updates are ignored, not applied.

## pycrdt pitfalls found while building this

1. **Awareness strings are length-prefixed in characters, not bytes.** `Encoder.write_var_string`
   uses `len(text)`, which corrupts any non-ASCII name. The server encodes awareness itself;
   a test sends `"José Ñúñez 😀"` through it.
2. **Out-of-order updates can be dropped.** Applying six updates from one writer in all 720
   orders: reference Yjs (JS) ends correct every time; pycrdt 0.14.6 / yrs 0.27.4 ends wrong in
   248. The missing update is reported by the state vector, so one sync handshake heals the
   replica. Mitigations: updates on one socket arrive in order; every reconnect handshakes; the
   stored log is loaded with `merge_updates`, which is immune to row order. A regression test
   skips itself once upstream fixes the behaviour.
3. **Text positions are UTF-8 bytes**, while browser Yjs uses UTF-16 code units. The server never
   edits text by position: version restores are made by the browser (ADR 0014), and branch
   merges apply the branch's own CRDT operations (ADR 0016), so nothing needs converting yet.
4. **Re-encoding a document drops updates that are still waiting.** An update whose predecessor
   has not arrived is kept pending inside the Doc, and `Doc.get_update()` leaves it out. Reference
   Yjs includes pending updates when encoding; yrs silently loses them. Folding "c, then delete a"
   without "a" through a Doc and adding "a" afterwards gives `ab`; `merge_updates` gives the
   correct `bc`. Compaction can fold an edit before its predecessor's transaction commits, so
   snapshots store the merged update, never a re-encoding (ADR 0003). A regression test commits
   two edits out of order around a compaction.

## Found in production: close frames that never arrive

On Render, the server's WebSocket close frame does not reach the browser. Probing the live service
with an invalid ticket: the server closes at once with `4401` (the same image does so in 48 ms
locally), but the client socket stays open; only after the client sends something does the edge
drop it, about ten seconds later, as `1006` with no code. So:

- **Close codes are hints, not guarantees.** Any unexpected close makes the client ask the ticket
  endpoint, which is the source of truth: a 404 there means removed or deleted, a fresh ticket
  carries a changed role.
- **Liveness is checked at the application level.** Browsers cannot send WebSocket pings, so the
  client sends a one-byte heartbeat (`120`) every 15 s and the server echoes it. A heartbeat left
  unanswered for 25 s counts as a dead connection. Without this, an idle reader would stay
  "online" after every deploy while receiving nothing.
- **"Unanswered", not "nothing heard lately".** The first version judged by silence (35 s since
  the last message). Chrome may run a hidden tab's timers only once a minute, which would have
  made such a tab reconnect every minute. Waiting for a specific heartbeat's reply has no such
  false alarm.
- **The server times out silent sockets too** (150 s, longer than a throttled tab's minute).
  Found while testing version history in a real browser: React's development double mount
  (start, stop, start while the first ticket request was in flight) let both pending connects
  open a socket, and the orphan, which nothing would ever close, kept its room in memory for
  good, so the end-of-session checkpoint never ran. The client now tags each connect with a
  generation and drops stale ones; the server timeout bounds any leak that remains, from a bug or
  from a network path that died without a close.

## Consequences

- More code than a library, all of it tested: sync, presence, roles, limits, persistence,
  shutdown, malformed input, and a Hypothesis property that replicas converge after a handshake
  whatever the delivery order and duplication.
- Points 2 and 3 are candidates for upstream issues on pycrdt.
