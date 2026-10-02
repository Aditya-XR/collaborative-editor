import asyncio
import base64
import hashlib
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from pycrdt import Decoder, Doc, merge_updates
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.auth.models import User
from app.branches.diff import Change, ChangeKind, blocks, compare
from app.branches.models import BranchStatus, DocumentBranch
from app.branches.schemas import BranchOut, ChangeOut, PersonOut
from app.collab.manager import RoomManager
from app.collab.models import DocumentSnapshot, SnapshotKind
from app.collab.room import CloseCode
from app.core.errors import ApiError
from app.core.ids import uuid7
from app.documents.models import ROLE_RANK, Document, DocumentRole
from app.documents.service import DocumentView

MAX_OPEN_BRANCHES = 10

Creator = aliased(User)
Merger = aliased(User)


def _now() -> datetime:
    return datetime.now(UTC)


# ----- permissions ------------------------------------------------------------------------------


@dataclass(frozen=True)
class Permissions:
    can_edit: bool  # change the branch's text, take main's changes, rename, request review
    can_merge: bool


def permissions(view: DocumentView, branch: DocumentBranch, user_id: uuid.UUID) -> Permissions:
    """Owners and editors may edit and merge any open branch. Commenters may branch and edit
    their own branches, to propose changes without edit rights: a fork and pull request."""
    if branch.status is not BranchStatus.OPEN:
        return Permissions(False, False)
    writer = view.role in (DocumentRole.OWNER, DocumentRole.EDITOR)
    own = view.role is DocumentRole.COMMENTER and branch.created_by == user_id
    return Permissions(can_edit=writer or own, can_merge=writer)


# ----- reading ----------------------------------------------------------------------------------


def _out(
    branch: DocumentBranch,
    creator: str | None,
    merger: str | None,
    allowed: Permissions,
) -> BranchOut:
    return BranchOut(
        id=branch.id,
        document_id=branch.document_id,
        name=branch.name,
        description=branch.description,
        status=branch.status,
        created_by=PersonOut(id=branch.created_by, name=creator)
        if branch.created_by and creator
        else None,
        created_at=branch.created_at,
        updated_at=branch.updated_at,
        review_requested_at=branch.review_requested_at,
        merged_by=PersonOut(id=branch.merged_by, name=merger)
        if branch.merged_by and merger
        else None,
        merged_at=branch.merged_at,
        closed_at=branch.closed_at,
        can_edit=allowed.can_edit,
        can_merge=allowed.can_merge,
    )


def _with_people() -> Any:
    return (
        select(DocumentBranch, Creator.name, Merger.name)
        .outerjoin(Creator, Creator.id == DocumentBranch.created_by)
        .outerjoin(Merger, Merger.id == DocumentBranch.merged_by)
    )


async def list_branches(
    session: AsyncSession, view: DocumentView, user_id: uuid.UUID
) -> list[BranchOut]:
    rows = await session.execute(
        _with_people()
        .where(DocumentBranch.document_id == view.document.id)
        # Open ones first, then the most recently active.
        .order_by(
            (DocumentBranch.status == BranchStatus.OPEN).desc(),
            DocumentBranch.updated_at.desc(),
        )
    )
    return [
        _out(branch, creator, merger, permissions(view, branch, user_id))
        for branch, creator, merger in rows
    ]


async def get_branch(
    session: AsyncSession, view: DocumentView, branch_id: uuid.UUID, *, lock: bool = False
) -> DocumentBranch:
    query = select(DocumentBranch).where(
        DocumentBranch.id == branch_id, DocumentBranch.document_id == view.document.id
    )
    if lock:
        # Serialises merges, closes and updates of one branch. NO KEY UPDATE, not UPDATE: saving
        # an edit to the branch checks its foreign key with a KEY SHARE lock on this row, which
        # FOR UPDATE would block, and a merge saves the branch's last edits while holding this.
        query = query.with_for_update(key_share=True)
    branch = await session.scalar(query)
    if branch is None:
        raise ApiError(404, "branch_not_found", "Branch not found")
    return branch


async def describe(
    session: AsyncSession, view: DocumentView, branch_id: uuid.UUID, user_id: uuid.UUID
) -> BranchOut:
    row = (
        await session.execute(
            _with_people().where(
                DocumentBranch.id == branch_id, DocumentBranch.document_id == view.document.id
            )
        )
    ).first()
    if row is None:
        raise ApiError(404, "branch_not_found", "Branch not found")
    branch, creator, merger = row
    return _out(branch, creator, merger, permissions(view, branch, user_id))


# ----- creating and changing --------------------------------------------------------------------


async def create(
    session: AsyncSession,
    rooms: RoomManager,
    view: DocumentView,
    user_id: uuid.UUID,
    name: str,
) -> DocumentBranch:
    """Forks main as it is now. The fork is both the branch's starting text and its merge base."""
    if ROLE_RANK[view.role] < ROLE_RANK[DocumentRole.COMMENTER]:
        raise ApiError(403, "insufficient_role", "Requires commenter access")
    # Saved and read before the lock below: saving main's edits updates the document's row,
    # which would otherwise wait for this transaction while it waits for the save.
    await rooms.flush(view.document.id)  # include what was typed a moment ago
    state = await rooms.store.state(view.document.id)
    # Locking the document makes the count and the insert one step, so two people branching
    # at once cannot both get the tenth slot. NO KEY UPDATE leaves edits to the document free
    # to save meanwhile (their foreign key checks take KEY SHARE locks on this row).
    await session.execute(
        select(Document.id).where(Document.id == view.document.id).with_for_update(key_share=True)
    )
    open_count = await session.scalar(
        select(func.count()).where(
            DocumentBranch.document_id == view.document.id,
            DocumentBranch.status == BranchStatus.OPEN,
        )
    )
    if (open_count or 0) >= MAX_OPEN_BRANCHES:
        raise ApiError(
            409,
            "too_many_branches",
            f"A document can have at most {MAX_OPEN_BRANCHES} open branches. "
            "Merge or close one first.",
        )
    branch = DocumentBranch(
        id=uuid7(),
        document_id=view.document.id,
        name=name,
        base_state=state,
        created_by=user_id,
    )
    session.add(branch)
    try:
        await session.flush()
    except IntegrityError as exc:
        await session.rollback()
        raise ApiError(409, "branch_name_taken", "An open branch already has that name") from exc
    session.add(
        DocumentSnapshot(
            id=uuid7(),
            document_id=view.document.id,
            branch_id=branch.id,
            kind=SnapshotKind.COMPACTION,
            state=state,
        )
    )
    await session.commit()
    return branch


async def update(
    session: AsyncSession,
    view: DocumentView,
    branch_id: uuid.UUID,
    user_id: uuid.UUID,
    *,
    name: str | None,
    description: str | None,
    review_requested: bool | None,
) -> None:
    branch = await get_branch(session, view, branch_id, lock=True)
    if not permissions(view, branch, user_id).can_edit:
        raise _read_only(branch)
    if name is not None:
        branch.name = name
    if description is not None:
        branch.description = description
    if review_requested is not None:
        branch.review_requested_at = (
            (branch.review_requested_at or _now()) if review_requested else None
        )
    branch.updated_at = _now()
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise ApiError(409, "branch_name_taken", "An open branch already has that name") from exc


async def close(
    session: AsyncSession,
    rooms: RoomManager,
    view: DocumentView,
    branch_id: uuid.UUID,
    user_id: uuid.UUID,
) -> None:
    branch = await get_branch(session, view, branch_id, lock=True)
    if not permissions(view, branch, user_id).can_edit:
        raise _read_only(branch)
    branch.status = BranchStatus.CLOSED
    branch.closed_at = branch.updated_at = _now()
    await session.commit()
    # Open editors reconnect, and their fresh tickets make the branch read-only.
    await rooms.close_stream(branch.id, CloseCode.ROLE_CHANGED, "Branch closed")


def _read_only(branch: DocumentBranch) -> ApiError:
    if branch.status is not BranchStatus.OPEN:
        return ApiError(409, "branch_not_open", f"This branch is {branch.status.value}")
    return ApiError(403, "insufficient_role", "Only its author or an editor can change this branch")


# ----- comparing --------------------------------------------------------------------------------


def _doc(state: bytes) -> Doc[Any]:
    doc: Doc[Any] = Doc()
    doc.apply_update(state)
    return doc


def state_digest(doc: Doc[Any]) -> str:
    """Identifies a document's content by its state vector: which operations of which client it
    holds. Decoded and sorted, because the encoding's order of clients is not guaranteed."""
    decoder = Decoder(doc.get_state())
    pairs = sorted(
        (decoder.read_var_uint(), decoder.read_var_uint()) for _ in range(decoder.read_var_uint())
    )
    return hashlib.sha256(repr(pairs).encode()).hexdigest()[:32]


@dataclass(frozen=True)
class Comparison:
    changes: list[Change]
    head: str
    preview: bytes

    @property
    def conflicts(self) -> int:
        return sum(change.kind is ChangeKind.CONFLICT for change in self.changes)


def compare_states(base: bytes, main: bytes, branch: bytes) -> Comparison:
    """CPU work: run it in a thread."""
    branch_doc = _doc(branch)
    changes = compare(blocks(_doc(base)), blocks(_doc(main)), blocks(branch_doc))
    return Comparison(changes, state_digest(branch_doc), merge_updates(main, branch))


async def comparison(
    session: AsyncSession, rooms: RoomManager, branch: DocumentBranch
) -> Comparison:
    # Read-your-writes: what was typed a moment ago on either side is part of the comparison.
    await rooms.flush(branch.document_id)
    await rooms.flush(branch.id)
    main = await rooms.store.state(branch.document_id)
    own = await rooms.store.state(branch.document_id, branch.id)
    base = await session.scalar(
        select(DocumentBranch.base_state).where(DocumentBranch.id == branch.id)
    )
    assert base is not None
    return await asyncio.to_thread(compare_states, base, main, own)


def change_out(change: Change) -> ChangeOut:
    return ChangeOut(kind=change.kind, base=change.base, main=change.main, branch=change.branch)


def encode(state: bytes) -> str:
    return base64.b64encode(state).decode()


def _diff_against(state: bytes) -> Any:
    """Builds what a room with the given state vector lacks from `state`."""
    return lambda state_vector: _doc(state).get_update(state_vector)


# ----- taking main's changes, and merging -------------------------------------------------------


async def update_from_main(
    session: AsyncSession,
    rooms: RoomManager,
    view: DocumentView,
    branch_id: uuid.UUID,
    user_id: uuid.UUID,
) -> None:
    """Brings main's changes since the fork into the branch, and moves the merge base up to main
    as it is now, the way `git merge main` does on a feature branch.

    Where both sides changed the same passage, the CRDT combines them; the person then fixes the
    passage in the branch, which shows up for review as an ordinary change.
    """
    branch = await get_branch(session, view, branch_id, lock=True)
    if not permissions(view, branch, user_id).can_edit:
        raise _read_only(branch)
    await rooms.flush(view.document.id)
    main = await rooms.store.state(view.document.id)
    # The branch must hold main's state before the base says it does, or a crash in between
    # would make main's changes look like the branch undoing them.
    await rooms.apply(view.document.id, branch.id, _diff_against(main), user_id)
    branch.base_state = main
    branch.updated_at = _now()
    await session.commit()


async def merge(
    session: AsyncSession,
    rooms: RoomManager,
    view: DocumentView,
    branch_id: uuid.UUID,
    user_id: uuid.UUID,
    head: str,
) -> DocumentBranch:
    """Applies the branch's changes to main, if it is exactly what was reviewed and nothing in
    it conflicts. Main is saved as a version first, so restoring that version undoes the merge.
    """
    branch = await get_branch(session, view, branch_id, lock=True)
    allowed = permissions(view, branch, user_id)
    if not allowed.can_merge:
        if branch.status is not BranchStatus.OPEN:
            raise _read_only(branch)
        raise ApiError(403, "insufficient_role", "Requires editor access")

    # No edits to the branch from here on: what is checked is what gets merged.
    room = rooms.rooms.get(branch.id)
    if room is not None:
        room.frozen = True
    try:
        found = await comparison(session, rooms, branch)
        if found.head != head:
            raise ApiError(
                409, "branch_changed", "The branch changed since you reviewed it. Review it again."
            )
        if found.conflicts:
            raise ApiError(
                409,
                "merge_conflicts",
                "Main changed the same passages. Update the branch from main, fix them there, "
                "and review again.",
            )
        await rooms.store.save_version(
            view.document.id, SnapshotKind.PRE_MERGE, label=branch.name, created_by=user_id
        )
        own = await rooms.store.state(view.document.id, branch.id)
        await rooms.apply(view.document.id, None, _diff_against(own), user_id)
    except BaseException:
        if room is not None:
            room.frozen = False
        raise
    branch.status = BranchStatus.MERGED
    branch.merged_by = user_id
    branch.merged_at = branch.updated_at = _now()
    await session.commit()
    await rooms.close_stream(branch.id, CloseCode.ROLE_CHANGED, "Branch merged")
    return branch
