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
   edits text today; branch merges and restores (phases 3 and 7) must convert positions.

## Consequences

- More code than a library, all of it tested: sync, presence, roles, limits, persistence,
  shutdown, malformed input, and a Hypothesis property that replicas converge after a handshake
  whatever the delivery order and duplication.
- Points 2 and 3 are candidates for upstream issues on pycrdt.
