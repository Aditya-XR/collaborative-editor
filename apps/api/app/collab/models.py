import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, LargeBinary, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class DocumentUpdate(Base):
    """Append-only log of Yjs updates. A document's state is every row, applied in id order.

    Compaction into snapshots arrives in phase 3; until then the log is the whole history.
    """

    __tablename__ = "document_updates"
    __table_args__ = (Index("ix_document_updates_document_id_id", "document_id", "id"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    document_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"))
    update: Mapped[bytes] = mapped_column(LargeBinary)
    # Who made the edit; kept for writing replay, survives the author deleting their account.
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
