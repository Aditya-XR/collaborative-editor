import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, LargeBinary, String, func, text
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class DocumentUpdate(Base):
    """Append-only log of Yjs updates since the document's compaction snapshot.

    A document's state is that snapshot plus every row here, merged. Compaction folds rows into
    the snapshot and deletes them (ADR 0003).
    """

    __tablename__ = "document_updates"
    __table_args__ = (Index("ix_document_updates_document_id_id", "document_id", "id"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    document_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"))
    update: Mapped[bytes] = mapped_column(LargeBinary)
    # Who made the edit; kept for writing replay, survives the author deleting their account.
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class SnapshotKind(StrEnum):
    # The base the edit log builds on. Internal: never listed as a version.
    COMPACTION = "compaction"
    # Taken by the server while people edit and when an editing session ends; the newest few
    # are kept.
    AUTO = "auto"
    # Saved or named by a person; kept until someone removes the name.
    NAMED = "named"
    # The state just before a version was restored, so a restore can itself be undone.
    PRE_RESTORE = "pre_restore"


VERSION_KINDS = (SnapshotKind.AUTO, SnapshotKind.NAMED, SnapshotKind.PRE_RESTORE)


class DocumentSnapshot(Base):
    """A document's whole Yjs state at one moment: the compaction base, or a version."""

    __tablename__ = "document_snapshots"
    __table_args__ = (
        Index("ix_document_snapshots_document_id_created_at", "document_id", "created_at"),
        # Loading reads exactly one base; the database guarantees there is never a second.
        Index(
            "uq_document_snapshots_compaction",
            "document_id",
            unique=True,
            postgresql_where=text("kind = 'compaction'"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    document_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"))
    kind: Mapped[SnapshotKind] = mapped_column(
        SAEnum(
            SnapshotKind,
            name="snapshot_kind",
            values_callable=lambda kinds: [kind.value for kind in kinds],
        )
    )
    state: Mapped[bytes] = mapped_column(LargeBinary)
    label: Mapped[str | None] = mapped_column(String(100))
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    # For a pre-restore snapshot: the version that was restored over it.
    source_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("document_snapshots.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
