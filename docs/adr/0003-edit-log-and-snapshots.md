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

## Implementation (phase 3, 2026-10-02)

- **One base per document.** `document_snapshots` rows of kind `compaction`; a partial unique
  index guarantees at most one per document. Other kinds are versions (ADR 0014).
- **When.** A room compacts once the log it knows of reaches 500 rows, and again when the
  editing session ends (the room leaves memory), so an idle document is one snapshot and an
  empty log. Neither blocks editing: the live document is in memory.
- **Never delete what was not read.** Compaction deletes exactly the ids it folded
  (`id = ANY(:ids)`), not "everything up to the highest id". Log ids come from a sequence, so an
  edit can take a lower id and commit later; it is invisible to the compaction and must stay.
- **Consistent loads.** Loading reads the base and the log in one `REPEATABLE READ` transaction,
  so a compaction committing between the two reads cannot hide rows.
- **Snapshots are merged updates, not re-encodings.** Re-encoding through a pycrdt Doc would
  garbage-collect deleted text, but drops edits still waiting for a predecessor (ADR 0012,
  pitfall 4). The price is size: deleted text stays in the snapshot.
- **Search text** is refreshed from every fold, without moving `updated_at`.

Measured with `benchmarks/load_document.py` (one writer, keystroke-sized updates, 15%
backspaces, local Postgres 18, median of 7 loads):

| Keystrokes | Log (rows, bytes) | Open from log | Snapshot | Open from snapshot | Next 500 folded in |
| --- | --- | --- | --- | --- | --- |
| 10,000 | 10,000 rows, 242 KB | 218 ms | 113 KB | 17 ms (13x) | 28 ms |
| 50,000 | 50,000 rows, 1.26 MB | 6,473 ms | 595 KB | 276 ms (23x) | 297 ms |

Opening from the log grows faster than the log (5x the rows, 30x the time), which is why the
log is never allowed to grow long. A garbage-collected snapshot would be about a third of the
size (37 KB and 189 KB); correctness wins over that saving.
