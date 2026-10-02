import uuid

from fastapi import APIRouter, Depends, Request, Response

from app.auth.deps import CurrentUser, limit_api_per_user
from app.branches import service
from app.branches.schemas import BranchCreate, BranchOut, BranchUpdate, MergeRequest, ReviewOut
from app.collab.manager import RoomManager
from app.core.deps import DbSession
from app.core.ratelimit.deps import enforce
from app.core.ratelimit.policies import BRANCH_CREATE_PER_USER
from app.documents import service as documents
from app.documents.models import DocumentRole

router = APIRouter(
    prefix="/documents/{doc_id}/branches",
    tags=["branches"],
    dependencies=[Depends(limit_api_per_user)],
)


def _rooms(request: Request) -> RoomManager:
    rooms: RoomManager = request.app.state.rooms
    return rooms


async def limit_branch_creation(request: Request, response: Response, user: CurrentUser) -> None:
    # Each branch copies the whole document, so creating them has its own, tighter budget.
    await enforce(request, response, BRANCH_CREATE_PER_USER, str(user.id))


@router.get("")
async def list_branches(
    doc_id: uuid.UUID, user: CurrentUser, session: DbSession
) -> list[BranchOut]:
    view = await documents.get_for(session, user, doc_id)
    return await service.list_branches(session, view, user.id)


@router.post("", status_code=201, dependencies=[Depends(limit_branch_creation)])
async def create_branch(
    doc_id: uuid.UUID, body: BranchCreate, request: Request, user: CurrentUser, session: DbSession
) -> BranchOut:
    """Forks the document as it is now. Commenters may branch, to propose changes."""
    view = await documents.get_for(session, user, doc_id, min_role=DocumentRole.COMMENTER)
    branch = await service.create(session, _rooms(request), view, user.id, body.name)
    return await service.describe(session, view, branch.id, user.id)


@router.get("/{branch_id}")
async def get_branch(
    doc_id: uuid.UUID, branch_id: uuid.UUID, user: CurrentUser, session: DbSession
) -> BranchOut:
    view = await documents.get_for(session, user, doc_id)
    return await service.describe(session, view, branch_id, user.id)


@router.patch("/{branch_id}")
async def update_branch(
    doc_id: uuid.UUID,
    branch_id: uuid.UUID,
    body: BranchUpdate,
    user: CurrentUser,
    session: DbSession,
) -> BranchOut:
    """Renames the branch, describes it, or asks for (or withdraws) review."""
    view = await documents.get_for(session, user, doc_id)
    await service.update(
        session,
        view,
        branch_id,
        user.id,
        name=body.name,
        description=body.description,
        review_requested=body.review_requested,
    )
    return await service.describe(session, view, branch_id, user.id)


@router.post("/{branch_id}/update-from-main")
async def update_from_main(
    doc_id: uuid.UUID, branch_id: uuid.UUID, request: Request, user: CurrentUser, session: DbSession
) -> BranchOut:
    view = await documents.get_for(session, user, doc_id)
    await service.update_from_main(session, _rooms(request), view, branch_id, user.id)
    return await service.describe(session, view, branch_id, user.id)


@router.get("/{branch_id}/review")
async def review(
    doc_id: uuid.UUID, branch_id: uuid.UUID, request: Request, user: CurrentUser, session: DbSession
) -> ReviewOut:
    """What merging the branch would change in main, and where both sides changed the same
    passages."""
    view = await documents.get_for(session, user, doc_id)
    branch = await service.get_branch(session, view, branch_id)
    found = await service.comparison(session, _rooms(request), branch)
    return ReviewOut(
        branch=await service.describe(session, view, branch_id, user.id),
        changes=[service.change_out(change) for change in found.changes],
        conflicts=found.conflicts,
        head=found.head,
        preview=service.encode(found.preview),
    )


@router.post("/{branch_id}/merge")
async def merge(
    doc_id: uuid.UUID,
    branch_id: uuid.UUID,
    body: MergeRequest,
    request: Request,
    user: CurrentUser,
    session: DbSession,
) -> BranchOut:
    view = await documents.get_for(session, user, doc_id)
    await service.merge(session, _rooms(request), view, branch_id, user.id, body.head)
    return await service.describe(session, view, branch_id, user.id)


@router.post("/{branch_id}/close")
async def close(
    doc_id: uuid.UUID, branch_id: uuid.UUID, request: Request, user: CurrentUser, session: DbSession
) -> BranchOut:
    """Abandons the branch: it stays readable, and nothing from it reaches main."""
    view = await documents.get_for(session, user, doc_id)
    await service.close(session, _rooms(request), view, branch_id, user.id)
    return await service.describe(session, view, branch_id, user.id)
