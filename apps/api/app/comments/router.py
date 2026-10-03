import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, Request, Response

from app.auth.deps import CurrentUser, limit_api_per_user
from app.collab.manager import RoomManager
from app.collab.protocol import COMMENTS
from app.comments import service
from app.comments.schemas import (
    CommentCreate,
    CommentUpdate,
    ThreadCreate,
    ThreadOut,
    ThreadUpdate,
)
from app.core.deps import AppSettings, DbSession
from app.core.mail import Mailer, send_all
from app.core.ratelimit.deps import enforce
from app.core.ratelimit.policies import COMMENT_WRITE_PER_USER
from app.documents import service as documents

router = APIRouter(
    prefix="/documents/{doc_id}",
    tags=["comments"],
    dependencies=[Depends(limit_api_per_user)],
)

CHANGED = bytes([COMMENTS])


async def limit_comment_writes(request: Request, response: Response, user: CurrentUser) -> None:
    # Each comment can send email, so writing them has its own budget.
    await enforce(request, response, COMMENT_WRITE_PER_USER, str(user.id))


def _rooms(request: Request) -> RoomManager:
    rooms: RoomManager = request.app.state.rooms
    return rooms


def _announce(request: Request, where: service.Stream) -> None:
    """Tells every open editor of the stream to fetch its comments again."""
    _rooms(request).notify(where.id, CHANGED)


def _mailer(request: Request) -> Mailer:
    mailer: Mailer = request.app.state.mailer
    return mailer


@router.get("/threads")
async def list_threads(
    doc_id: uuid.UUID,
    user: CurrentUser,
    session: DbSession,
    branch_id: uuid.UUID | None = None,
) -> list[ThreadOut]:
    """Viewers may read comments; commenting needs commenter access."""
    view = await documents.get_for(session, user, doc_id)
    where = await service.stream(session, view, branch_id)
    return await service.list_threads(session, where, user.id)


@router.post("/threads", status_code=201, dependencies=[Depends(limit_comment_writes)])
async def create_thread(
    doc_id: uuid.UUID,
    body: ThreadCreate,
    request: Request,
    background: BackgroundTasks,
    user: CurrentUser,
    session: DbSession,
    settings: AppSettings,
) -> ThreadOut:
    view = await documents.get_for(session, user, doc_id)
    where = await service.stream(session, view, body.branch_id)
    thread = await service.create_thread(
        session,
        where,
        user,
        anchor_start=body.anchor_start,
        anchor_end=body.anchor_end,
        quoted_text=body.quoted_text,
        body=body.body,
    )
    _announce(request, where)
    emails = await service.notifications(
        session, where, thread, user, body.body, new_thread=True, frontend_url=settings.frontend_url
    )
    background.add_task(send_all, _mailer(request), emails)
    return await service.describe(session, where, thread.id, user.id)


@router.patch("/threads/{thread_id}")
async def update_thread(
    doc_id: uuid.UUID,
    thread_id: uuid.UUID,
    body: ThreadUpdate,
    request: Request,
    user: CurrentUser,
    session: DbSession,
) -> ThreadOut:
    """Resolves or reopens a thread."""
    view = await documents.get_for(session, user, doc_id)
    where, thread = await service.thread_stream(session, view, thread_id)
    await service.set_resolved(session, where, thread, user.id, body.resolved)
    _announce(request, where)
    return await service.describe(session, where, thread_id, user.id)


@router.post(
    "/threads/{thread_id}/comments",
    status_code=201,
    dependencies=[Depends(limit_comment_writes)],
)
async def reply(
    doc_id: uuid.UUID,
    thread_id: uuid.UUID,
    body: CommentCreate,
    request: Request,
    background: BackgroundTasks,
    user: CurrentUser,
    session: DbSession,
    settings: AppSettings,
) -> ThreadOut:
    view = await documents.get_for(session, user, doc_id)
    where, thread = await service.thread_stream(session, view, thread_id)
    await service.reply(session, where, thread, user, body.body)
    _announce(request, where)
    emails = await service.notifications(
        session,
        where,
        thread,
        user,
        body.body,
        new_thread=False,
        frontend_url=settings.frontend_url,
    )
    background.add_task(send_all, _mailer(request), emails)
    return await service.describe(session, where, thread_id, user.id)


@router.patch("/comments/{comment_id}", dependencies=[Depends(limit_comment_writes)])
async def edit_comment(
    doc_id: uuid.UUID,
    comment_id: uuid.UUID,
    body: CommentUpdate,
    request: Request,
    user: CurrentUser,
    session: DbSession,
) -> ThreadOut:
    view = await documents.get_for(session, user, doc_id)
    where, thread = await service.edit_comment(session, view, comment_id, user.id, body.body)
    _announce(request, where)
    return await service.describe(session, where, thread.id, user.id)


@router.delete("/comments/{comment_id}", status_code=204)
async def delete_comment(
    doc_id: uuid.UUID,
    comment_id: uuid.UUID,
    request: Request,
    user: CurrentUser,
    session: DbSession,
) -> None:
    """Deletes a comment; deleting a thread's first comment deletes the whole thread."""
    view = await documents.get_for(session, user, doc_id)
    where, _ = await service.delete_comment(session, view, comment_id, user.id)
    _announce(request, where)
