# 0003 · Store documents as an append-only edit log plus snapshots

- **Status:** accepted
- **Date:** 2026-09-28

## Context

v1 re-encoded and rewrote the entire document state to MongoDB on every change (later debounced
to 3 seconds). Write cost grew with document size, not with the size of the edit, and a crash
inside the debounce window lost everything since the last write.

## Options

1. **Rewrite the full state on every change or on a timer.** Simple; write amplification grows
   with the document; the debounce window is a loss window.
2. **Append each small Yjs update to a log, and periodically compact the log into a snapshot.**
   The same idea as a database's write-ahead log and checkpoints.

## Decision

Option 2.

- `document_updates` is append-only. The API instance that received an edit from a browser saves
  it, so every edit is written exactly once with no cross-instance lock (see the plan's storage
  section).
- A saver batches inserts every 500 ms or 50 updates.
- When the log passes 500 rows, one transaction under `pg_try_advisory_xact_lock` merges the latest
  snapshot and the log into a new snapshot, deletes the merged rows and refreshes `search_text`.
- Loading a document = latest snapshot + every later update.

## Consequences

- Writes are proportional to the edit (tens of bytes), not the document.
- The at-risk window is at most 500 ms, and even then connected browsers still hold the update
  and re-send it when they reconnect, so loss requires the server and every client holding the
  edit to fail together.
- Snapshots double as version history; named versions are snapshots that compaction keeps.
- Writing-replay (a stretch goal) needs the fine-grained log, so compaction will retain raw
  updates for a limited window if that feature ships.
