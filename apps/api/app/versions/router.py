import uuid

from fastapi import APIRouter, Depends, Request

from app.auth.deps import CurrentUser, limit_api_per_user
from app.collab.manager import RoomManager
from app.collab.models import SnapshotKind
from app.core.deps import AppSettings, DbSession
from app.documents import service as documents
from app.documents.models import DocumentRole
from app.versions import service
from app.versions.schemas import VersionCreate, VersionDetail, VersionOut, VersionRename

# Version history is for editors, as in Google Docs: it can show text that was deleted on
# purpose, which viewers and commenters were never meant to see again.
router = APIRouter(
    prefix="/documents/{doc_id}/versions",
    tags=["versions"],
    dependencies=[Depends(limit_api_per_user)],
)


def _rooms(request: Request) -> RoomManager:
    rooms: RoomManager = request.app.state.rooms
    return rooms


@router.get("")
async def list_versions(
    doc_id: uuid.UUID, user: CurrentUser, session: DbSession
) -> list[VersionOut]:
    await documents.get_for(session, user, doc_id, min_role=DocumentRole.EDITOR)
    return await service.list_versions(session, doc_id)


@router.post("", status_code=201)
async def save_version(
    doc_id: uuid.UUID,
    body: VersionCreate,
    request: Request,
    user: CurrentUser,
    session: DbSession,
    settings: AppSettings,
) -> VersionOut:
    """Saves the document as it is now, under a name."""
    await documents.get_for(session, user, doc_id, min_role=DocumentRole.EDITOR)
    await service.ensure_room_for_named(session, doc_id, settings.versions_named_max)
    rooms = _rooms(request)
    await rooms.flush(doc_id)  # include what was typed in the last few hundred milliseconds
    version = await rooms.store.save_version(
        doc_id, SnapshotKind.NAMED, label=body.label, created_by=user.id
    )
    return await service.describe(session, doc_id, version.id)


@router.get("/{version_id}")
async def get_version(
    doc_id: uuid.UUID, version_id: uuid.UUID, user: CurrentUser, session: DbSession
) -> VersionDetail:
    await documents.get_for(session, user, doc_id, min_role=DocumentRole.EDITOR)
    return await service.get_version(session, doc_id, version_id)


@router.patch("/{version_id}")
async def rename_version(
    doc_id: uuid.UUID,
    version_id: uuid.UUID,
    body: VersionRename,
    user: CurrentUser,
    session: DbSession,
    settings: AppSettings,
) -> VersionOut:
    await documents.get_for(session, user, doc_id, min_role=DocumentRole.EDITOR)
    return await service.rename(
        session, doc_id, version_id, body.label, settings.versions_named_max
    )


@router.post("/{version_id}/restore", status_code=201)
async def prepare_restore(
    doc_id: uuid.UUID,
    version_id: uuid.UUID,
    request: Request,
    user: CurrentUser,
    session: DbSession,
) -> VersionOut:
    """Saves the current state as a pre-restore version, so the restore can be undone.

    The restore itself is an ordinary edit made by the browser (ADR 0014): it turns the live
    document into the version through the editor, which keeps everyone's concurrent edits
    merging normally and lets the person press Ctrl+Z.
    """
    await documents.get_for(session, user, doc_id, min_role=DocumentRole.EDITOR)
    await service.describe(session, doc_id, version_id)  # 404 if it is not a version here
    rooms = _rooms(request)
    await rooms.flush(doc_id)
    saved = await rooms.store.save_version(
        doc_id, SnapshotKind.PRE_RESTORE, created_by=user.id, source_id=version_id
    )
    return await service.describe(session, doc_id, saved.id)
