import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Request, Response

from app.auth.deps import CurrentUser, limit_api_per_user
from app.collab.manager import RoomManager
from app.collab.room import CloseCode
from app.core.deps import DbSession
from app.core.ratelimit.deps import enforce
from app.core.ratelimit.policies import SHARING_PER_USER
from app.documents import service as documents
from app.documents.models import DocumentRole
from app.sharing import service
from app.sharing.models import ShareLink
from app.sharing.schemas import (
    AcceptOut,
    AcceptRequest,
    InviteRequest,
    LinkCreate,
    LinkCreated,
    LinkOut,
    MemberOut,
    RoleUpdate,
    TransferRequest,
)

router = APIRouter(tags=["sharing"], dependencies=[Depends(limit_api_per_user)])


async def limit_sharing(request: Request, response: Response, user: CurrentUser) -> None:
    # Invites and links are how access spreads; a tighter budget blunts account probing.
    await enforce(request, response, SHARING_PER_USER, str(user.id))


def _rooms(request: Request) -> RoomManager:
    rooms: RoomManager = request.app.state.rooms
    return rooms


def _now() -> datetime:
    return datetime.now(UTC)


def _link_out(link: ShareLink) -> LinkOut:
    return LinkOut(
        id=link.id, role=link.role, created_at=link.created_at, expires_at=link.expires_at
    )


# ----- members ----------------------------------------------------------------------------------


@router.get("/documents/{doc_id}/members")
async def list_members(doc_id: uuid.UUID, user: CurrentUser, session: DbSession) -> list[MemberOut]:
    await documents.get_for(session, user, doc_id)  # any member may see who else has access
    return await service.list_members(session, doc_id)


@router.post("/documents/{doc_id}/members", status_code=201, dependencies=[Depends(limit_sharing)])
async def invite_member(
    doc_id: uuid.UUID, body: InviteRequest, user: CurrentUser, session: DbSession
) -> MemberOut:
    view = await documents.get_for(session, user, doc_id, min_role=DocumentRole.EDITOR)
    return await service.invite(session, view, body.email, body.role.as_document_role())


@router.patch("/documents/{doc_id}/members/{member_id}", status_code=204)
async def change_role(
    doc_id: uuid.UUID,
    member_id: uuid.UUID,
    body: RoleUpdate,
    request: Request,
    user: CurrentUser,
    session: DbSession,
) -> None:
    view = await documents.get_for(session, user, doc_id, min_role=DocumentRole.OWNER)
    await service.change_role(session, view, member_id, body.role.as_document_role())
    # Their open editor reconnects and picks up the new role from a fresh ticket.
    await _rooms(request).disconnect_user(
        doc_id, member_id, CloseCode.ROLE_CHANGED, "Your access changed"
    )


@router.delete("/documents/{doc_id}/members/{member_id}", status_code=204)
async def remove_member(
    doc_id: uuid.UUID,
    member_id: uuid.UUID,
    request: Request,
    user: CurrentUser,
    session: DbSession,
) -> None:
    view = await documents.get_for(session, user, doc_id)
    await service.remove(session, view, user.id, member_id)
    await _rooms(request).disconnect_user(
        doc_id, member_id, CloseCode.FORBIDDEN, "Your access was removed"
    )


@router.post("/documents/{doc_id}/transfer-ownership", status_code=204)
async def transfer_ownership(
    doc_id: uuid.UUID,
    body: TransferRequest,
    request: Request,
    user: CurrentUser,
    session: DbSession,
) -> None:
    view = await documents.get_for(session, user, doc_id, min_role=DocumentRole.OWNER)
    await service.transfer_ownership(session, view, body.user_id)
    for affected in (user.id, body.user_id):
        await _rooms(request).disconnect_user(
            doc_id, affected, CloseCode.ROLE_CHANGED, "Ownership changed"
        )


# ----- links ------------------------------------------------------------------------------------


@router.get("/documents/{doc_id}/links")
async def list_links(doc_id: uuid.UUID, user: CurrentUser, session: DbSession) -> list[LinkOut]:
    await documents.get_for(session, user, doc_id, min_role=DocumentRole.EDITOR)
    return [_link_out(link) for link in await service.list_links(session, doc_id, _now())]


@router.post("/documents/{doc_id}/links", status_code=201, dependencies=[Depends(limit_sharing)])
async def create_link(
    doc_id: uuid.UUID, body: LinkCreate, user: CurrentUser, session: DbSession
) -> LinkCreated:
    view = await documents.get_for(session, user, doc_id, min_role=DocumentRole.EDITOR)
    link, token = await service.create_link(
        session, view, user.id, body.role.as_document_role(), body.expires_in_days, _now()
    )
    return LinkCreated(**_link_out(link).model_dump(), token=token)


@router.delete("/documents/{doc_id}/links/{link_id}", status_code=204)
async def revoke_link(
    doc_id: uuid.UUID, link_id: uuid.UUID, user: CurrentUser, session: DbSession
) -> None:
    await documents.get_for(session, user, doc_id, min_role=DocumentRole.EDITOR)
    await service.revoke_link(session, doc_id, link_id, _now())


@router.post("/links/accept", dependencies=[Depends(limit_sharing)])
async def accept_link(
    body: AcceptRequest, request: Request, user: CurrentUser, session: DbSession
) -> AcceptOut:
    document_id, role, changed = await service.accept_link(session, user, body.token, _now())
    if changed:
        # An upgrade (say viewer to editor) should take effect in an editor that is already open.
        await _rooms(request).disconnect_user(
            document_id, user.id, CloseCode.ROLE_CHANGED, "Your access changed"
        )
    return AcceptOut(document_id=document_id, role=role)
