import base64
import uuid
from datetime import datetime

from sqlalchemy import Row, Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased, defer

from app.auth.models import User
from app.collab.models import VERSION_KINDS, DocumentSnapshot, SnapshotKind
from app.core.errors import ApiError
from app.versions.schemas import AuthorOut, VersionDetail, VersionOut, VersionRef

Source = aliased(DocumentSnapshot)

# Outer joins: the author and the source may be missing, whatever the column types say.
VersionRow = Row[DocumentSnapshot, str | None, uuid.UUID | None, str | None, datetime | None]


def _versions(
    document_id: uuid.UUID,
) -> Select[DocumentSnapshot, str | None, uuid.UUID | None, str | None, datetime | None]:
    """Versions with their author and, for pre-restore versions, what was restored."""
    return (
        select(DocumentSnapshot, User.name, Source.id, Source.label, Source.created_at)
        .outerjoin(User, User.id == DocumentSnapshot.created_by)
        .outerjoin(Source, Source.id == DocumentSnapshot.source_id)
        .where(
            DocumentSnapshot.document_id == document_id,
            DocumentSnapshot.kind.in_(VERSION_KINDS),
        )
    )


def _out(row: VersionRow) -> VersionOut:
    version, author_name, source_id, source_label, source_created_at = row
    return VersionOut(
        id=version.id,
        kind=version.kind.value,
        label=version.label,
        created_at=version.created_at,
        created_by=(
            AuthorOut(id=version.created_by, name=author_name)
            if version.created_by is not None and author_name is not None
            else None
        ),
        restored_from=(
            VersionRef(id=source_id, label=source_label, created_at=source_created_at)
            if source_id is not None and source_created_at is not None
            else None
        ),
    )


async def list_versions(session: AsyncSession, document_id: uuid.UUID) -> list[VersionOut]:
    rows = await session.execute(
        _versions(document_id)
        # The states are the bulk of the table and a list never shows them.
        .options(defer(DocumentSnapshot.state))
        .order_by(DocumentSnapshot.created_at.desc(), DocumentSnapshot.id.desc())
    )
    return [_out(row) for row in rows]


async def get_version(
    session: AsyncSession, document_id: uuid.UUID, version_id: uuid.UUID
) -> VersionDetail:
    row = (
        await session.execute(_versions(document_id).where(DocumentSnapshot.id == version_id))
    ).first()
    if row is None:
        raise ApiError(404, "version_not_found", "Version not found")
    state = base64.b64encode(row[0].state).decode()
    return VersionDetail(**_out(row).model_dump(), state=state)


async def describe(
    session: AsyncSession, document_id: uuid.UUID, version_id: uuid.UUID
) -> VersionOut:
    row = (
        await session.execute(
            _versions(document_id)
            .options(defer(DocumentSnapshot.state))
            .where(DocumentSnapshot.id == version_id)
        )
    ).first()
    if row is None:
        raise ApiError(404, "version_not_found", "Version not found")
    return _out(row)


async def ensure_room_for_named(session: AsyncSession, document_id: uuid.UUID, limit: int) -> None:
    """Named versions are kept forever, so their number per document is capped."""
    count = await session.scalar(
        select(func.count()).where(
            DocumentSnapshot.document_id == document_id,
            DocumentSnapshot.kind == SnapshotKind.NAMED,
        )
    )
    if (count or 0) >= limit:
        raise ApiError(
            409,
            "too_many_versions",
            f"A document can keep at most {limit} named versions. Remove a name to add another.",
        )


async def rename(
    session: AsyncSession,
    document_id: uuid.UUID,
    version_id: uuid.UUID,
    label: str | None,
    named_limit: int,
) -> VersionOut:
    version = await session.scalar(
        select(DocumentSnapshot)
        .options(defer(DocumentSnapshot.state))
        .where(
            DocumentSnapshot.id == version_id,
            DocumentSnapshot.document_id == document_id,
            DocumentSnapshot.kind.in_(VERSION_KINDS),
        )
    )
    if version is None:
        raise ApiError(404, "version_not_found", "Version not found")
    if label is not None and version.kind is not SnapshotKind.NAMED:
        await ensure_room_for_named(session, document_id, named_limit)
    version.label = label
    version.kind = SnapshotKind.NAMED if label is not None else SnapshotKind.AUTO
    await session.commit()
    return await describe(session, document_id, version_id)
