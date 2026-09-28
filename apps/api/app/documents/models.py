import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy import Enum as SAEnum
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


class Document(Base):
    __tablename__ = "documents"

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
