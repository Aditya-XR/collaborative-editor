import uuid
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, StringConstraints

from app.branches.diff import ChangeKind
from app.branches.models import BranchStatus

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)]
Description = Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)]


class BranchCreate(BaseModel):
    name: Name


class BranchUpdate(BaseModel):
    name: Name | None = None
    description: Description | None = None
    # True turns the branch into a merge request; false withdraws it.
    review_requested: bool | None = None


class PersonOut(BaseModel):
    id: uuid.UUID
    name: str


class BranchOut(BaseModel):
    id: uuid.UUID
    document_id: uuid.UUID
    name: str
    description: str
    status: BranchStatus
    created_by: PersonOut | None
    created_at: datetime
    updated_at: datetime
    review_requested_at: datetime | None
    merged_by: PersonOut | None
    merged_at: datetime | None
    closed_at: datetime | None
    # What the person asking may do with it.
    can_edit: bool
    can_merge: bool


class ChangeOut(BaseModel):
    kind: ChangeKind
    # The blocks' text on each side: the merge base, main now, and the branch.
    base: list[str]
    main: list[str]
    branch: list[str]


class ReviewOut(BaseModel):
    branch: BranchOut
    changes: list[ChangeOut]
    conflicts: int
    # Identifies the branch content reviewed; a merge must send it back unchanged.
    head: str
    # Main as it would be after merging: a base64 Yjs update, rendered by the browser.
    preview: str


class MergeRequest(BaseModel):
    head: Annotated[str, StringConstraints(min_length=1, max_length=128)]
