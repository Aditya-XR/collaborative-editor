# 0002 · PostgreSQL as the system of record

- **Status:** accepted
- **Date:** 2026-09-28

## Context

v1 stored everything in MongoDB. Its review found collaborators stored in two incompatible shapes
in the same array, documents created without an owner, and ownership assigned to whoever opened an
ownerless document first. All three are integrity problems a schema would have rejected.

v2's data is relational: users, document memberships with roles, share links, branches, merge
requests, comment threads. Permission checks join these on every request.

## Decision

Use **PostgreSQL** (Neon in production, `postgres:17` locally and in CI) through async SQLAlchemy 2
and Alembic migrations.

## Consequences

- Foreign keys, `NOT NULL`, enums and composite primary keys make the v1 bugs unrepresentable,
  e.g. `document_members(doc_id, user_id)` cannot hold a malformed collaborator.
- Transactions keep multi-row changes atomic: compaction, merges, ownership transfer.
- Binary Yjs updates and snapshots fit in `bytea` columns; full-text search uses a generated
  `tsvector` with a GIN index, so no separate search service is needed.
- Advisory locks (`pg_try_advisory_xact_lock`) coordinate compaction without Redis.
- Schema changes need migrations, reviewed like code.
