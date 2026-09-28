import uuid
from datetime import datetime
from enum import StrEnum
from typing import Annotated

from pydantic import BaseModel, StringConstraints

from app.documents.models import DocumentRole

Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class Scope(StrEnum):
    ALL = "all"
    OWNED = "owned"
    SHARED = "shared"


class DocumentCreate(BaseModel):
    title: Title = "Untitled document"


class DocumentUpdate(BaseModel):
    title: Title


class OwnerOut(BaseModel):
    id: uuid.UUID
    name: str


class DocumentOut(BaseModel):
    id: uuid.UUID
    title: str
    role: DocumentRole
    owner: OwnerOut
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None
