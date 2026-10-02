import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import DateTime, ForeignKey, Index, LargeBinary, String, Text, func, text
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class BranchStatus(StrEnum):
    OPEN = "open"
    MERGED = "merged"  # read-only from then on
    CLOSED = "closed"  # abandoned; read-only


class DocumentBranch(Base):
    """A private copy of a document that is edited separately and merged back (ADR 0016).

    Its edits have their own log and snapshot (rows with this branch_id in document_updates and
    document_snapshots), so a branch is an ordinary collaboration room with its own stream.
    """

    __tablename__ = "document_branches"
    __table_args__ = (
        # Names identify open branches; a merged or closed one frees its name.
        Index(
            "uq_document_branches_open_name",
            "document_id",
            "name",
            unique=True,
            postgresql_where=text("status = 'open'"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    document_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(60))
    # What the author proposes and why; shown when review is requested.
    description: Mapped[str] = mapped_column(Text, server_default="")
    status: Mapped[BranchStatus] = mapped_column(
        SAEnum(
            BranchStatus,
            name="branch_status",
            values_callable=lambda statuses: [status.value for status in statuses],
        ),
        server_default=BranchStatus.OPEN.value,
    )
    # Main as it was when the branch forked or last took main's changes: the merge base.
    base_state: Mapped[bytes] = mapped_column(LargeBinary, deferred=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # Set when the author asks for review: the branch is then a merge request.
    review_requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    merged_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    merged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
