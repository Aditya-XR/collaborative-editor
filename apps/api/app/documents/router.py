import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response

from app.auth.deps import CurrentUser, limit_api_per_user
from app.collab.room import CloseCode
from app.core.deps import DbSession
from app.documents import service
from app.documents.models import DocumentRole
from app.documents.schemas import DocumentCreate, DocumentOut, DocumentUpdate, Scope, SearchHit

router = APIRouter(
    prefix="/documents", tags=["documents"], dependencies=[Depends(limit_api_per_user)]
)


@router.get("")
async def list_documents(
    user: CurrentUser,
    session: DbSession,
    scope: Scope = Scope.ALL,
    trashed: bool = False,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
) -> list[DocumentOut]:
    views = await service.list_for(session, user, scope=scope, trashed=trashed, limit=limit)
    return [view.out() for view in views]


# Declared before /{doc_id}, which would otherwise try to read "search" as an id.
@router.get("/search")
async def search_documents(
    user: CurrentUser,
    session: DbSession,
    q: Annotated[str, Query(min_length=1, max_length=200)],
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
) -> list[SearchHit]:
    """Full-text search over the titles and bodies of the documents the user can open."""
    return await service.search(session, user, q, limit)


@router.post("", status_code=201)
async def create_document(
    user: CurrentUser, session: DbSession, body: DocumentCreate | None = None
) -> DocumentOut:
    view = await service.create(session, user, (body or DocumentCreate()).title)
    return view.out()


@router.put("/{doc_id}", responses={200: {"description": "Already existed"}, 201: {}})
async def put_document(
    doc_id: uuid.UUID,
    user: CurrentUser,
    session: DbSession,
    response: Response,
    body: DocumentCreate | None = None,
) -> DocumentOut:
    """Create a document with an id minted by the client. Safe to repeat."""
    view, created = await service.create_with_id(
        session, user, doc_id, (body or DocumentCreate()).title
    )
    response.status_code = 201 if created else 200
    return view.out()


@router.get("/{doc_id}")
async def get_document(doc_id: uuid.UUID, user: CurrentUser, session: DbSession) -> DocumentOut:
    return (await service.get_for(session, user, doc_id)).out()


@router.patch("/{doc_id}")
async def rename_document(
    doc_id: uuid.UUID, body: DocumentUpdate, user: CurrentUser, session: DbSession
) -> DocumentOut:
    view = await service.get_for(session, user, doc_id, min_role=DocumentRole.EDITOR)
    return (await service.rename(session, view, body.title)).out()


@router.delete("/{doc_id}", status_code=204)
async def trash_document(
    doc_id: uuid.UUID, request: Request, user: CurrentUser, session: DbSession
) -> None:
    view = await service.get_for(session, user, doc_id, min_role=DocumentRole.OWNER)
    await service.trash(session, view, datetime.now(UTC))
    await request.app.state.rooms.close_document(
        doc_id, CloseCode.NOT_FOUND, "Document moved to trash"
    )


@router.post("/{doc_id}/restore")
async def restore_document(doc_id: uuid.UUID, user: CurrentUser, session: DbSession) -> DocumentOut:
    view = await service.get_for(
        session, user, doc_id, min_role=DocumentRole.OWNER, include_trashed=True
    )
    return (await service.restore(session, view)).out()
