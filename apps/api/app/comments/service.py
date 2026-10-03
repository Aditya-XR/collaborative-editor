import base64
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import ColumnElement, delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.auth.models import User
from app.branches.models import BranchStatus, DocumentBranch
from app.comments.models import Comment, CommentThread
from app.comments.schemas import CommentOut, PersonOut, ThreadOut
from app.core.errors import ApiError
from app.core.ids import uuid7
from app.core.mail import Email, one_line
from app.documents.models import ROLE_RANK, DocumentMember, DocumentRole
from app.documents.service import DocumentView

# Soft caps against flooding, checked before inserting (two writers at once may pass one).
MAX_THREADS_PER_STREAM = 1000
MAX_COMMENTS_PER_THREAD = 200

Author = aliased(User)
Resolver = aliased(User)


def _now() -> datetime:
    return datetime.now(UTC)


# ----- permissions ------------------------------------------------------------------------------


@dataclass(frozen=True)
class Stream:
    """Where comments live: a document's main text, or one of its branches."""

    view: DocumentView
    branch: DocumentBranch | None

    @property
    def branch_id(self) -> uuid.UUID | None:
        return self.branch.id if self.branch else None

    @property
    def id(self) -> uuid.UUID:
        """The collaboration room's key, which gets the live "comments changed" signal."""
        return self.branch_id or self.view.document.id

    @property
    def open(self) -> bool:
        # A merged or closed branch is read-only, its discussion included.
        return self.branch is None or self.branch.status is BranchStatus.OPEN

    @property
    def can_comment(self) -> bool:
        return self.open and ROLE_RANK[self.view.role] >= ROLE_RANK[DocumentRole.COMMENTER]

    @property
    def can_moderate(self) -> bool:
        """Owners and editors may delete anyone's comment."""
        return self.open and self.view.role in (DocumentRole.OWNER, DocumentRole.EDITOR)

    def require_comment(self) -> None:
        if not self.open:
            assert self.branch is not None
            raise ApiError(409, "branch_not_open", f"This branch is {self.branch.status.value}")
        if not self.can_comment:
            raise ApiError(403, "insufficient_role", "Requires commenter access")

    def where(self) -> ColumnElement[bool]:
        in_document = CommentThread.document_id == self.view.document.id
        if self.branch is None:
            return in_document & CommentThread.branch_id.is_(None)
        return in_document & (CommentThread.branch_id == self.branch.id)


async def stream(session: AsyncSession, view: DocumentView, branch_id: uuid.UUID | None) -> Stream:
    if branch_id is None:
        return Stream(view, None)
    branch = await session.scalar(
        select(DocumentBranch).where(
            DocumentBranch.id == branch_id, DocumentBranch.document_id == view.document.id
        )
    )
    if branch is None:
        raise ApiError(404, "branch_not_found", "Branch not found")
    return Stream(view, branch)


# ----- reading ----------------------------------------------------------------------------------


def _person(person_id: uuid.UUID | None, name: str | None) -> PersonOut | None:
    return PersonOut(id=person_id, name=name) if person_id and name else None


def _encode(anchor: bytes) -> str:
    return base64.b64encode(anchor).decode()


async def list_threads(
    session: AsyncSession, where: Stream, user_id: uuid.UUID, *, only: uuid.UUID | None = None
) -> list[ThreadOut]:
    """Every thread on the stream (resolved ones too; the browser filters), oldest first, each
    with its comments in order. Two queries, whatever the number of threads."""
    query = (
        select(CommentThread, Resolver.name)
        .outerjoin(Resolver, Resolver.id == CommentThread.resolved_by)
        .where(where.where())
        .order_by(CommentThread.id)
    )
    if only is not None:
        query = query.where(CommentThread.id == only)
    threads = (await session.execute(query)).all()
    if not threads:
        return []
    rows = await session.execute(
        select(Comment, Author.name)
        .outerjoin(Author, Author.id == Comment.author_id)
        .where(Comment.thread_id.in_([thread.id for thread, _ in threads]))
        .order_by(Comment.thread_id, Comment.id)
    )
    comments: dict[uuid.UUID, list[CommentOut]] = {}
    for comment, author in rows:
        mine = comment.author_id == user_id
        comments.setdefault(comment.thread_id, []).append(
            CommentOut(
                id=comment.id,
                author=_person(comment.author_id, author),
                body=comment.body,
                created_at=comment.created_at,
                edited_at=comment.edited_at,
                can_edit=mine and where.can_comment,
                can_delete=(mine and where.can_comment) or where.can_moderate,
            )
        )
    return [
        ThreadOut(
            id=thread.id,
            branch_id=thread.branch_id,
            anchor_start=_encode(thread.anchor_start),
            anchor_end=_encode(thread.anchor_end),
            quoted_text=thread.quoted_text,
            created_at=thread.created_at,
            resolved_at=thread.resolved_at,
            resolved_by=_person(thread.resolved_by, resolver),
            comments=comments.get(thread.id, []),
            can_reply=where.can_comment,
        )
        for thread, resolver in threads
    ]


async def describe(
    session: AsyncSession, where: Stream, thread_id: uuid.UUID, user_id: uuid.UUID
) -> ThreadOut:
    found = await list_threads(session, where, user_id, only=thread_id)
    if not found:
        raise ApiError(404, "thread_not_found", "Comment thread not found")
    return found[0]


async def _thread(session: AsyncSession, view: DocumentView, thread_id: uuid.UUID) -> CommentThread:
    thread = await session.scalar(
        select(CommentThread).where(
            CommentThread.id == thread_id, CommentThread.document_id == view.document.id
        )
    )
    if thread is None:
        raise ApiError(404, "thread_not_found", "Comment thread not found")
    return thread


async def thread_stream(
    session: AsyncSession, view: DocumentView, thread_id: uuid.UUID
) -> tuple[Stream, CommentThread]:
    thread = await _thread(session, view, thread_id)
    return await stream(session, view, thread.branch_id), thread


# ----- writing ----------------------------------------------------------------------------------


async def create_thread(
    session: AsyncSession,
    where: Stream,
    author: User,
    *,
    anchor_start: bytes,
    anchor_end: bytes,
    quoted_text: str,
    body: str,
) -> CommentThread:
    where.require_comment()
    count = await session.scalar(select(func.count()).where(where.where()))
    if (count or 0) >= MAX_THREADS_PER_STREAM:
        raise ApiError(
            409,
            "too_many_threads",
            f"This text has {MAX_THREADS_PER_STREAM} comment threads; delete some first.",
        )
    thread = CommentThread(
        id=uuid7(),
        document_id=where.view.document.id,
        branch_id=where.branch_id,
        anchor_start=anchor_start,
        anchor_end=anchor_end,
        quoted_text=quoted_text,
        created_by=author.id,
    )
    session.add(thread)
    await session.flush()
    session.add(Comment(id=uuid7(), thread_id=thread.id, author_id=author.id, body=body))
    await session.commit()
    return thread


async def reply(
    session: AsyncSession, where: Stream, thread: CommentThread, author: User, body: str
) -> Comment:
    where.require_comment()
    count = await session.scalar(select(func.count()).where(Comment.thread_id == thread.id))
    if (count or 0) >= MAX_COMMENTS_PER_THREAD:
        raise ApiError(
            409,
            "too_many_comments",
            f"A thread holds at most {MAX_COMMENTS_PER_THREAD} comments; start a new one.",
        )
    comment = Comment(id=uuid7(), thread_id=thread.id, author_id=author.id, body=body)
    session.add(comment)
    # Replying to a resolved discussion reopens it, as it does in Google Docs.
    thread.resolved_at = thread.resolved_by = None
    await session.commit()
    return comment


async def set_resolved(
    session: AsyncSession, where: Stream, thread: CommentThread, user_id: uuid.UUID, resolved: bool
) -> None:
    where.require_comment()
    if resolved and thread.resolved_at is None:
        thread.resolved_at, thread.resolved_by = _now(), user_id
    elif not resolved:
        thread.resolved_at = thread.resolved_by = None
    await session.commit()


async def _comment(
    session: AsyncSession, view: DocumentView, comment_id: uuid.UUID
) -> tuple[Comment, CommentThread]:
    row = (
        await session.execute(
            select(Comment, CommentThread)
            .join(CommentThread, CommentThread.id == Comment.thread_id)
            .where(Comment.id == comment_id, CommentThread.document_id == view.document.id)
        )
    ).first()
    if row is None:
        raise ApiError(404, "comment_not_found", "Comment not found")
    comment, thread = row
    return comment, thread


async def edit_comment(
    session: AsyncSession, view: DocumentView, comment_id: uuid.UUID, user_id: uuid.UUID, body: str
) -> tuple[Stream, CommentThread]:
    comment, thread = await _comment(session, view, comment_id)
    where = await stream(session, view, thread.branch_id)
    where.require_comment()
    if comment.author_id != user_id:
        raise ApiError(403, "not_author", "Only its author can edit a comment")
    if comment.body != body:
        comment.body = body
        comment.edited_at = _now()
        await session.commit()
    return where, thread


async def delete_comment(
    session: AsyncSession, view: DocumentView, comment_id: uuid.UUID, user_id: uuid.UUID
) -> tuple[Stream, bool]:
    """Deletes one comment, or the whole thread when it is the thread's first. Returns the stream
    and whether the thread went too."""
    comment, thread = await _comment(session, view, comment_id)
    where = await stream(session, view, thread.branch_id)
    where.require_comment()
    if comment.author_id != user_id and not where.can_moderate:
        raise ApiError(403, "not_author", "Only its author or an editor can delete a comment")
    first = await session.scalar(
        select(Comment.id).where(Comment.thread_id == thread.id).order_by(Comment.id).limit(1)
    )
    whole_thread = first == comment.id
    if whole_thread:
        await session.execute(delete(CommentThread).where(CommentThread.id == thread.id))
    else:
        await session.execute(delete(Comment).where(Comment.id == comment.id))
    await session.commit()
    return where, whole_thread


# ----- notifications ----------------------------------------------------------------------------


async def notifications(
    session: AsyncSession,
    where: Stream,
    thread: CommentThread,
    actor: User,
    body: str,
    *,
    new_thread: bool,
    frontend_url: str,
) -> list[Email]:
    """Emails about a new comment: to everyone who took part in the thread and, for a new
    thread, to the document's owner. Never to the author, and only to people who can still open
    the document."""
    document = where.view.document
    participants: set[Any] = set(
        await session.scalars(select(Comment.author_id).where(Comment.thread_id == thread.id))
    )
    participants.add(thread.created_by)
    if new_thread:
        participants.add(document.owner_id)
    participants.discard(None)
    participants.discard(actor.id)
    if not participants:
        return []
    recipients = await session.scalars(
        select(User.email)
        .join(DocumentMember, DocumentMember.user_id == User.id)
        .where(DocumentMember.document_id == document.id, User.id.in_(participants))
        .order_by(User.email)
    )

    title = one_line(document.title, 80)
    verb = "commented on" if new_thread else "replied on"
    place = (
        f"{title}” (branch “{one_line(where.branch.name, 60)}”)" if where.branch else f"{title}”"
    )
    link = f"{frontend_url}/d/{document.id}"
    if where.branch is not None:
        link += f"/b/{where.branch.id}"
    quote = one_line(thread.quoted_text, 200)
    text = (
        f"{actor.name} {verb} “{place}:\n\n" + (f"> {quote}\n\n" if quote else "") + f"{body}\n\n"
        f"Open the document: {link}?thread={thread.id}\n\n"
        "You received this because you own the document or took part in this discussion.\n"
    )
    subject = one_line(f"{actor.name} {verb} “{title}”")
    return [Email(to=email, subject=subject, text=text) for email in recipients]
