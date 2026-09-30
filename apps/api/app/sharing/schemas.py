import uuid
from datetime import datetime
from enum import StrEnum
from typing import Annotated

from pydantic import BaseModel, EmailStr, Field

from app.documents.models import DocumentRole


class ShareRole(StrEnum):
    """Roles that can be granted. Ownership moves only through a transfer."""

    EDITOR = "editor"
    COMMENTER = "commenter"
    VIEWER = "viewer"

    def as_document_role(self) -> DocumentRole:
        return DocumentRole(self.value)


class MemberUser(BaseModel):
    id: uuid.UUID
    name: str
    email: str


class MemberOut(BaseModel):
    user: MemberUser
    role: DocumentRole
    added_at: datetime


class InviteRequest(BaseModel):
    email: EmailStr
    role: ShareRole


class RoleUpdate(BaseModel):
    role: ShareRole


class LinkCreate(BaseModel):
    role: ShareRole
    # None means the link never expires.
    expires_in_days: Annotated[int, Field(ge=1, le=365)] | None = 7


class LinkOut(BaseModel):
    id: uuid.UUID
    role: DocumentRole
    created_at: datetime
    expires_at: datetime | None


class LinkCreated(LinkOut):
    # Returned exactly once; the server keeps only its hash.
    token: str


class AcceptRequest(BaseModel):
    # In the body rather than the URL path, so request logs never contain it.
    token: Annotated[str, Field(min_length=16, max_length=128)]


class AcceptOut(BaseModel):
    document_id: uuid.UUID
    role: DocumentRole


class TransferRequest(BaseModel):
    user_id: uuid.UUID
