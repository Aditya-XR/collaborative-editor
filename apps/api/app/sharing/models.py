import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.core.ids import uuid7
from app.documents.models import DocumentRole


class ShareLink(Base):
    """A link that grants a role on a document to whoever opens it while signed in.

    Only the SHA-256 of the token is stored: a leaked database cannot be turned into working
    links, and the token is shown once, when the link is created.
    """

    __tablename__ = "share_links"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    document_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE"), index=True
    )
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    role: Mapped[DocumentRole] = mapped_column(
        SAEnum(
            DocumentRole,
            name="document_role",
            values_callable=lambda roles: [role.value for role in roles],
            create_type=False,  # the type already exists (document_members.role)
        )
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # Null means the link never expires; revoking is always possible.
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
