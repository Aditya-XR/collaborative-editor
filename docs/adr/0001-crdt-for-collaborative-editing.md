# 0001 · Use a CRDT (Yjs) to merge concurrent edits

- **Status:** accepted
- **Date:** 2026-09-28

## Context

Several people edit the same document at once, sometimes offline for hours. Their edits must end
in the same document everywhere, without a "someone else changed this" error, and offline work
must merge when the connection returns. Branches (ADR to come) also need to merge a long-lived
copy back into a document that kept changing.

## Options

1. **Operational transformation (OT).** Every edit goes through a central server that transforms
   it against concurrent edits. Proven (Google Docs), but the server must order every operation,
   offline editing is awkward, and correct transform functions are notoriously hard to write.
2. **CRDT (Yjs).** Each character gets a unique id and a position relative to its neighbours, so
   any two copies that have seen the same set of updates are identical, in any delivery order.
3. **Last write wins / locking.** Simple, but loses work or blocks people.

## Decision

Use **Yjs** in the browser and **pycrdt** (Yjs-compatible, built on the Rust port Yrs) on the
server. Both speak the same binary update and sync protocol.

## Consequences

- Offline editing, reconnects and branch merges fall out of the data structure: apply the
  missing updates in any order, any number of times.
- The server is still needed, but for authority rather than ordering: permissions, persistence,
  relaying updates, version history and merge review.
- Cost: metadata per character and tombstones for deleted text. Yjs garbage collection reclaims
  most of it; documents stay far below the sizes where this matters for this project.
- Convergence is not intent: when two people rewrite the same sentence, the result contains both
  edits. Branch merge requests therefore flag overlapping edits for human review.
- Convergence is verified by a property-based test (random concurrent edits, shuffled and
  duplicated delivery, identical results).
