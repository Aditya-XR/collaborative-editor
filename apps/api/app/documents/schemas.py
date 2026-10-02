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


class SnippetPart(BaseModel):
    text: str
    match: bool


class SearchHit(BaseModel):
    document: DocumentOut
    # A passage of the body around the matches, split so the client can highlight the matched
    # words without rendering any HTML. Empty when only the title matched.
    snippet: list[SnippetPart]
