import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, StringConstraints

Label = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]


class VersionCreate(BaseModel):
    label: Label


class VersionRename(BaseModel):
    """A label makes a version named (kept for good); null makes it automatic again."""

    label: Label | None


class AuthorOut(BaseModel):
    id: uuid.UUID
    name: str


class VersionRef(BaseModel):
    id: uuid.UUID
    label: str | None
    created_at: datetime


class VersionOut(BaseModel):
    id: uuid.UUID
    kind: Literal["auto", "named", "pre_restore"]
    label: str | None
    created_at: datetime
    # Null for versions the server took by itself, or whose author deleted their account.
    created_by: AuthorOut | None
    # Set on a pre-restore version: what was restored over it (null once that was pruned).
    restored_from: VersionRef | None


class VersionDetail(VersionOut):
    # The whole document at this version, as a base64 Yjs update: the browser renders it with
    # the same editor, so formatting looks exactly as it did.
    state: str
