import secrets
import uuid
from datetime import datetime, timedelta

from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.auth.service import normalize_email
from app.core.errors import ApiError
from app.core.security import hash_token
from app.documents.models import ROLE_RANK, Document, DocumentMember, DocumentRole
from app.documents.service import DocumentView
from app.sharing.models import ShareLink
from app.sharing.schemas import MemberOut, MemberUser


async def list_members(session: AsyncSession, document_id: uuid.UUID) -> list[MemberOut]:
    rows = await session.execute(
        select(DocumentMember, User)
        .join(User, User.id == DocumentMember.user_id)
        .where(DocumentMember.document_id == document_id)
    )
    members = [
        MemberOut(
            user=MemberUser(id=user.id, name=user.name, email=user.email),
            role=member.role,
            added_at=member.created_at,
        )
        for member, user in rows
    ]
    # Owner first, then by role, then alphabetically: the order a sharing dialog reads best in.
    return sorted(members, key=lambda m: (-ROLE_RANK[m.role], m.user.name.lower()))


async def invite(
    session: AsyncSession, view: DocumentView, email: str, role: DocumentRole
) -> MemberOut:
    user = await session.scalar(select(User).where(User.email == normalize_email(email)))
    if user is None:
        raise ApiError(
            404, "user_not_found", "No account uses that email. Share a link with them instead."
        )
    member = DocumentMember(document_id=view.document.id, user_id=user.id, role=role)
    session.add(member)
    try:
        await session.flush()
    except IntegrityError as exc:
        await session.rollback()
        raise ApiError(409, "already_member", "That person already has access") from exc
    await session.commit()
    return MemberOut(
        user=MemberUser(id=user.id, name=user.name, email=user.email),
        role=role,
        added_at=member.created_at,
    )


async def _membership(
    session: AsyncSession, document_id: uuid.UUID, user_id: uuid.UUID
) -> DocumentMember:
    member = await session.get(DocumentMember, (document_id, user_id))
    if member is None:
        raise ApiError(404, "member_not_found", "That person does not have access")
    return member


async def change_role(
    session: AsyncSession, view: DocumentView, user_id: uuid.UUID, role: DocumentRole
) -> None:
    member = await _membership(session, view.document.id, user_id)
    if member.role is DocumentRole.OWNER:
        raise ApiError(400, "owner_role_fixed", "Transfer ownership to change the owner's role")
    member.role = role
    await session.commit()


async def remove(
    session: AsyncSession, view: DocumentView, actor_id: uuid.UUID, user_id: uuid.UUID
) -> None:
    """Owners can remove anyone else; everyone can remove themselves (leave the document)."""
    member = await _membership(session, view.document.id, user_id)
    if member.role is DocumentRole.OWNER:
        raise ApiError(400, "owner_cannot_leave", "Transfer ownership before leaving")
    if user_id != actor_id and view.role is not DocumentRole.OWNER:
        raise ApiError(403, "insufficient_role", "Only the owner can remove people")
    await session.delete(member)
    await session.commit()


async def transfer_ownership(
    session: AsyncSession, view: DocumentView, new_owner_id: uuid.UUID
) -> None:
    document = view.document
    if new_owner_id == document.owner_id:
        raise ApiError(400, "already_owner", "You already own this document")
    new_owner = await _membership(session, document.id, new_owner_id)
    old_owner = await _membership(session, document.id, document.owner_id)
    new_owner.role = DocumentRole.OWNER
    old_owner.role = DocumentRole.EDITOR  # the previous owner keeps working on it
    document.owner_id = new_owner_id
    await session.commit()


# ----- links ------------------------------------------------------------------------------------


async def create_link(
    session: AsyncSession,
    view: DocumentView,
    creator_id: uuid.UUID,
    role: DocumentRole,
    expires_in_days: int | None,
    now: datetime,
) -> tuple[ShareLink, str]:
    token = secrets.token_urlsafe(24)
    link = ShareLink(
        document_id=view.document.id,
        token_hash=hash_token(token),
        role=role,
        created_by=creator_id,
        expires_at=now + timedelta(days=expires_in_days) if expires_in_days else None,
    )
    session.add(link)
    await session.commit()
    return link, token


async def list_links(
    session: AsyncSession, document_id: uuid.UUID, now: datetime
) -> list[ShareLink]:
    rows = await session.scalars(
        select(ShareLink)
        .where(
            ShareLink.document_id == document_id,
            ShareLink.revoked_at.is_(None),
            or_(ShareLink.expires_at.is_(None), ShareLink.expires_at > now),
        )
        .order_by(ShareLink.created_at.desc())
    )
    return list(rows)


async def revoke_link(
    session: AsyncSession, document_id: uuid.UUID, link_id: uuid.UUID, now: datetime
) -> None:
    link = await session.get(ShareLink, link_id)
    if link is None or link.document_id != document_id:
        raise ApiError(404, "link_not_found", "Link not found")
    if link.revoked_at is None:
        link.revoked_at = now
        await session.commit()


async def accept_link(
    session: AsyncSession, user: User, token: str, now: datetime
) -> tuple[uuid.UUID, DocumentRole, bool]:
    """Grants the link's role. Returns (document id, resulting role, whether the role changed).

    A link never lowers anyone's access: an editor opening a view link stays an editor.
    """
    link = await session.scalar(select(ShareLink).where(ShareLink.token_hash == hash_token(token)))
    if link is None:
        raise ApiError(404, "link_not_found", "This link is not valid")
    if link.revoked_at is not None or (link.expires_at is not None and link.expires_at <= now):
        raise ApiError(410, "link_expired", "This link has expired or was turned off")
    document = await session.get(Document, link.document_id)
    if document is None or document.deleted_at is not None:
        raise ApiError(404, "document_not_found", "Document not found")

    user_id, document_id, role = user.id, document.id, link.role
    member = await session.get(DocumentMember, (document_id, user_id))
    if member is not None:
        if ROLE_RANK[member.role] >= ROLE_RANK[role]:
            return document_id, member.role, False
        member.role = role
        await session.commit()
        return document_id, role, True

    session.add(DocumentMember(document_id=document_id, user_id=user_id, role=role))
    try:
        await session.commit()
    except IntegrityError:
        # The same person accepted in two tabs at once; the other request already added them.
        await session.rollback()
        existing = await session.get(DocumentMember, (document_id, user_id))
        return document_id, existing.role if existing else role, False
    return document_id, role, True
