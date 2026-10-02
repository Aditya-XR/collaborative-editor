import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import Computed, DateTime, ForeignKey, Index, String, Text, func
from sqlalchemy import Enum as SAEnum
from sqlalchemy.dialects.postgresql import TSVECTOR
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class DocumentRole(StrEnum):
    OWNER = "owner"
    EDITOR = "editor"
    COMMENTER = "commenter"
    VIEWER = "viewer"


ROLE_RANK: dict[DocumentRole, int] = {
    DocumentRole.VIEWER: 0,
    DocumentRole.COMMENTER: 1,
    DocumentRole.EDITOR: 2,
    DocumentRole.OWNER: 3,
}


# Every word is indexed twice: stemmed ('english': "running" -> "run", so "runs" finds it) and
# as written ('simple': so the prefix "runn" typed so far finds "running" too).
SEARCH_VECTOR = (
    "setweight(to_tsvector('english'::regconfig, title)"
    " || to_tsvector('simple'::regconfig, title), 'A')"
    " || setweight(to_tsvector('english'::regconfig, search_text)"
    " || to_tsvector('simple'::regconfig, search_text), 'B')"
)


class Document(Base):
    __tablename__ = "documents"
    __table_args__ = (Index("ix_documents_search_tsv", "search_tsv", postgresql_using="gin"),)

    # No server default: the id may come from the browser (UUIDv7) for offline creation.
    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    title: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    # Set when moved to Trash; the row stays so the owner can restore it.
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Plain text of the body, refreshed whenever the server folds the edit log (compaction or a
    # new version). Deferred: lists never need it, and it can be long.
    search_text: Mapped[str] = mapped_column(Text, server_default="", deferred=True)
    search_tsv: Mapped[str] = mapped_column(
        TSVECTOR, Computed(SEARCH_VECTOR, persisted=True), deferred=True
    )


class DocumentMember(Base):
    """Who can open a document and with which role. No row means no access at all."""

    __tablename__ = "document_members"

    document_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    role: Mapped[DocumentRole] = mapped_column(
        SAEnum(
            DocumentRole,
            name="document_role",
            values_callable=lambda roles: [role.value for role in roles],
        )
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
