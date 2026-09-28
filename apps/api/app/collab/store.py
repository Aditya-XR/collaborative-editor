import uuid
from dataclasses import dataclass

from sqlalchemy import func, insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.collab.models import DocumentUpdate
from app.documents.models import Document


@dataclass(frozen=True)
class PendingUpdate:
    update: bytes
    user_id: uuid.UUID | None


class UpdateStore:
    """Reads and appends a document's Yjs update log in Postgres."""

    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sessionmaker = sessionmaker

    async def load(self, document_id: uuid.UUID) -> list[bytes]:
        async with self._sessionmaker() as session:
            rows = await session.scalars(
                select(DocumentUpdate.update)
                .where(DocumentUpdate.document_id == document_id)
                .order_by(DocumentUpdate.id)
            )
            return list(rows)

    async def append(self, document_id: uuid.UUID, pending: list[PendingUpdate]) -> None:
        if not pending:
            return
        async with self._sessionmaker() as session, session.begin():
            await session.execute(
                insert(DocumentUpdate),
                [
                    {"document_id": document_id, "update": item.update, "user_id": item.user_id}
                    for item in pending
                ],
            )
            # Content changed, so the dashboard's "Edited …" and ordering should move too.
            await session.execute(
                update(Document).where(Document.id == document_id).values(updated_at=func.now())
            )
