import base64
import binascii
import uuid
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, BeforeValidator, StringConstraints, WithJsonSchema

# A relative position is a client id and a clock, or a type name: a few dozen bytes at most.
MAX_ANCHOR_BYTES = 256


def _decode_anchor(value: object) -> bytes:
    if not isinstance(value, str) or len(value) > 2 * MAX_ANCHOR_BYTES:
        raise ValueError("must be a base64 string")
    try:
        decoded = base64.b64decode(value, validate=True)
    except binascii.Error as exc:
        raise ValueError("must be base64") from exc
    if not 0 < len(decoded) <= MAX_ANCHOR_BYTES:
        raise ValueError(f"must decode to 1-{MAX_ANCHOR_BYTES} bytes")
    return decoded


# Base64 on the wire, bytes once validated.
Anchor = Annotated[
    bytes,
    BeforeValidator(_decode_anchor),
    WithJsonSchema({"type": "string", "format": "byte"}),
]
Body = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)]
Quote = Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]


class ThreadCreate(BaseModel):
    # Comment on one of the document's branches instead of its main text.
    branch_id: uuid.UUID | None = None
    anchor_start: Anchor
    anchor_end: Anchor
    quoted_text: Quote
    body: Body


class ThreadUpdate(BaseModel):
    resolved: bool


class CommentCreate(BaseModel):
    body: Body


class CommentUpdate(BaseModel):
    body: Body


class PersonOut(BaseModel):
    id: uuid.UUID
    name: str


class CommentOut(BaseModel):
    id: uuid.UUID
    # None once the author's account is deleted.
    author: PersonOut | None
    body: str
    created_at: datetime
    edited_at: datetime | None
    # What the person asking may do with it.
    can_edit: bool
    can_delete: bool


class ThreadOut(BaseModel):
    id: uuid.UUID
    branch_id: uuid.UUID | None
    anchor_start: str
    anchor_end: str
    quoted_text: str
    created_at: datetime
    resolved_at: datetime | None
    resolved_by: PersonOut | None
    comments: list[CommentOut]
    can_reply: bool
