import asyncio
import uuid
from dataclasses import dataclass
from typing import Any

from pycrdt import Doc, merge_updates
from sqlalchemy import (
    BigInteger,
    ColumnElement,
    any_,
    bindparam,
    delete,
    func,
    insert,
    select,
    update,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.collab.models import DocumentSnapshot, DocumentUpdate, SnapshotKind
from app.collab.protocol import EMPTY_UPDATE
from app.collab.text import plain_text
from app.core.ids import uuid7
from app.documents.models import Document


@dataclass(frozen=True)
class PendingUpdate:
    update: bytes
    user_id: uuid.UUID | None


@dataclass(frozen=True)
class StoredDocument:
    """Everything needed to rebuild a document: its compaction snapshot (if any) first, then
    every logged update after it, in order."""

    updates: list[bytes]
    log_rows: int


@dataclass(frozen=True)
class Folded:
    state: bytes
    text: str


def fold(updates: list[bytes]) -> Folded:
    """Merges stored updates into one, which becomes the snapshot, and extracts its text.

    The merged update is stored as is. Re-encoding it through a Doc would garbage-collect
    deleted text and be smaller, but pycrdt/yrs then silently drops every edit still waiting for
    one it depends on (ADR 0012), and compaction can fold such an edit before its predecessor's
    transaction commits. A merge keeps everything, whatever the order.
    """
    state = merged(updates)
    doc: Doc[Any] = Doc()
    doc.apply_update(state)
    return Folded(state, plain_text(doc))


def _lock_key(stream_id: uuid.UUID) -> int:
    """A bigint for pg_try_advisory_xact_lock. The low 64 bits of a UUIDv7 are random, so two
    streams almost never share a key, and if they do, one compaction just waits a turn."""
    return int.from_bytes(stream_id.bytes[8:], "big", signed=True)


def _in_stream(
    model: type[DocumentUpdate] | type[DocumentSnapshot],
    document_id: uuid.UUID,
    branch_id: uuid.UUID | None,
) -> ColumnElement[bool]:
    """Rows of one stream: a document's main text, or one of its branches."""
    if branch_id is None:
        return (model.document_id == document_id) & model.branch_id.is_(None)
    return model.branch_id == branch_id


def merged(updates: list[bytes]) -> bytes:
    """One update holding everything in the list, whatever its order (ADR 0012, pitfall 2)."""
    return merge_updates(*updates) if updates else EMPTY_UPDATE


class UpdateStore:
    """Durable state in Postgres, per stream (a document's main text or one of its branches): an
    append-only log of Yjs updates on top of a compaction snapshot (ADR 0003). Main also has the
    versions people see in the history, and the text that search indexes."""

    def __init__(
        self, sessionmaker: async_sessionmaker[AsyncSession], *, auto_versions_kept: int = 50
    ) -> None:
        self._sessionmaker = sessionmaker
        self._auto_versions_kept = auto_versions_kept

    async def load(
        self, document_id: uuid.UUID, branch_id: uuid.UUID | None = None
    ) -> StoredDocument:
        async with self._sessionmaker() as session, session.begin():
            # Both reads see one snapshot of the database. Otherwise a compaction committing
            # between them could move rows into a base that was already read: lost edits.
            await session.connection(execution_options={"isolation_level": "REPEATABLE READ"})
            base = await session.scalar(
                select(DocumentSnapshot.state).where(
                    _in_stream(DocumentSnapshot, document_id, branch_id),
                    DocumentSnapshot.kind == SnapshotKind.COMPACTION,
                )
            )
            rows = list(
                await session.scalars(
                    select(DocumentUpdate.update)
                    .where(_in_stream(DocumentUpdate, document_id, branch_id))
                    .order_by(DocumentUpdate.id)
                )
            )
        return StoredDocument(([base] if base is not None else []) + rows, len(rows))

    async def state(self, document_id: uuid.UUID, branch_id: uuid.UUID | None = None) -> bytes:
        """The stream's whole saved state as one update."""
        return merged((await self.load(document_id, branch_id)).updates)

    async def append(
        self,
        document_id: uuid.UUID,
        pending: list[PendingUpdate],
        branch_id: uuid.UUID | None = None,
    ) -> None:
        if not pending:
            return
        async with self._sessionmaker() as session, session.begin():
            await session.execute(
                insert(DocumentUpdate),
                [
                    {
                        "document_id": document_id,
                        "branch_id": branch_id,
                        "update": item.update,
                        "user_id": item.user_id,
                    }
                    for item in pending
                ],
            )
            # Content changed, so the dashboard's "Edited …" and ordering should move too.
            # Branch edits leave the branch's row alone: a merge holds that row locked while it
            # saves the branch's last edits, which would otherwise wait on the merge itself.
            if branch_id is None:
                await session.execute(
                    update(Document).where(Document.id == document_id).values(updated_at=func.now())
                )

    async def compact(
        self, document_id: uuid.UUID, branch_id: uuid.UUID | None = None
    ) -> int | None:
        """Folds the stream's log into its compaction snapshot and deletes the folded rows.

        Returns how many rows were folded, or None if another instance is compacting this
        stream right now (it will have folded them, or the next attempt will).
        """
        async with self._sessionmaker() as session, session.begin():
            locked = await session.scalar(
                select(func.pg_try_advisory_xact_lock(_lock_key(branch_id or document_id)))
            )
            if not locked:
                return None
            base = await session.scalar(
                select(DocumentSnapshot).where(
                    _in_stream(DocumentSnapshot, document_id, branch_id),
                    DocumentSnapshot.kind == SnapshotKind.COMPACTION,
                )
            )
            rows = (
                await session.execute(
                    select(DocumentUpdate.id, DocumentUpdate.update)
                    .where(_in_stream(DocumentUpdate, document_id, branch_id))
                    .order_by(DocumentUpdate.id)
                )
            ).all()
            if not rows:
                return 0

            updates = ([base.state] if base is not None else []) + [row.update for row in rows]
            folded = await asyncio.to_thread(fold, updates)
            if base is None:
                session.add(
                    DocumentSnapshot(
                        id=uuid7(),
                        document_id=document_id,
                        branch_id=branch_id,
                        kind=SnapshotKind.COMPACTION,
                        state=folded.state,
                    )
                )
            else:
                base.state = folded.state
                base.created_at = func.now()
            # Exactly the rows that were folded, never "everything up to id N": an edit whose
            # transaction took an id earlier but commits later is invisible here, and must stay
            # in the log rather than be deleted unread.
            ids = bindparam("ids", [row.id for row in rows], type_=ARRAY(BigInteger))
            await session.execute(delete(DocumentUpdate).where(DocumentUpdate.id == any_(ids)))
            if branch_id is None:  # search covers main only
                await self._refresh_search_text(session, document_id, folded.text)
        return len(rows)

    async def save_version(
        self,
        document_id: uuid.UUID,
        kind: SnapshotKind,
        *,
        label: str | None = None,
        created_by: uuid.UUID | None = None,
        source_id: uuid.UUID | None = None,
    ) -> DocumentSnapshot:
        """Stores the document's current saved state as a version."""
        folded = await asyncio.to_thread(fold, (await self.load(document_id)).updates)
        async with self._sessionmaker() as session, session.begin():
            version = DocumentSnapshot(
                id=uuid7(),
                document_id=document_id,
                kind=kind,
                state=folded.state,
                label=label,
                created_by=created_by,
                source_id=source_id,
            )
            session.add(version)
            await session.flush()
            if kind is not SnapshotKind.NAMED:
                await self._prune_unnamed_versions(session, document_id)
            await self._refresh_search_text(session, document_id, folded.text)
        return version

    async def _prune_unnamed_versions(self, session: AsyncSession, document_id: uuid.UUID) -> None:
        """Keeps the newest unnamed versions (automatic, pre-restore, pre-merge); named ones are
        never pruned."""
        unnamed = DocumentSnapshot.kind.in_(
            (SnapshotKind.AUTO, SnapshotKind.PRE_RESTORE, SnapshotKind.PRE_MERGE)
        )
        keep = (
            select(DocumentSnapshot.id)
            .where(DocumentSnapshot.document_id == document_id, unnamed)
            .order_by(DocumentSnapshot.created_at.desc(), DocumentSnapshot.id.desc())
            .limit(self._auto_versions_kept)
        )
        await session.execute(
            delete(DocumentSnapshot).where(
                DocumentSnapshot.document_id == document_id,
                unnamed,
                DocumentSnapshot.id.not_in(keep),
            )
        )

    @staticmethod
    async def _refresh_search_text(
        session: AsyncSession, document_id: uuid.UUID, text: str
    ) -> None:
        await session.execute(
            update(Document)
            .where(Document.id == document_id)
            # Kept as is: refreshing the index is not an edit, so "Edited …" must not move.
            .values(search_text=text, updated_at=Document.updated_at)
        )
