import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, LargeBinary, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class CommentThread(Base):
    """A discussion attached to a passage of a document's main text or of one of its branches.

    The passage is kept as two Yjs relative positions, not as a mark in the text: a relative
    position names a character by its CRDT id, so it moves with that character through
    everyone's edits, and commenting never edits the document (commenters cannot) (ADR 0017).
    """

    __tablename__ = "comment_threads"
    __table_args__ = (
        Index("ix_comment_threads_document_id_branch_id", "document_id", "branch_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    document_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"))
    # Null for the document's main text.
    branch_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("document_branches.id", ondelete="CASCADE")
    )
    # Encoded Y.RelativePosition values, opaque to the server; the browser resolves them.
    anchor_start: Mapped[bytes] = mapped_column(LargeBinary)
    anchor_end: Mapped[bytes] = mapped_column(LargeBinary)
    # The passage as it read when the thread was opened, shown if it is later deleted.
    quoted_text: Mapped[str] = mapped_column(Text)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolved_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )


class Comment(Base):
    """One message in a thread. The thread's first comment opens it; deleting that deletes the
    thread."""

    __tablename__ = "comments"
    __table_args__ = (Index("ix_comments_thread_id_id", "thread_id", "id"),)

    # UUIDv7: ordering by id is ordering by time, which is how a thread reads.
    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    thread_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("comment_threads.id", ondelete="CASCADE")
    )
    author_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
