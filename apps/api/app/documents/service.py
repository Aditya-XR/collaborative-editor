import re
import uuid
from dataclasses import dataclass
from datetime import datetime
from functools import reduce
from typing import Any

from sqlalchemy import ColumnElement, Select, and_, func, literal_column, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.core.errors import ApiError
from app.core.ids import uuid7
from app.documents.models import ROLE_RANK, Document, DocumentMember, DocumentRole
from app.documents.schemas import DocumentOut, OwnerOut, Scope, SearchHit, SnippetPart


@dataclass(frozen=True)
class DocumentView:
    """A document as one particular user sees it: with their role and the owner's name."""

    document: Document
    role: DocumentRole
    owner_name: str

    def out(self) -> DocumentOut:
        doc = self.document
        return DocumentOut(
            id=doc.id,
            title=doc.title,
            role=self.role,
            owner=OwnerOut(id=doc.owner_id, name=self.owner_name),
            created_at=doc.created_at,
            updated_at=doc.updated_at,
            deleted_at=doc.deleted_at,
        )


def _visible_to(user: User) -> Select[Document, DocumentRole, str]:
    return (
        select(Document, DocumentMember.role, User.name)
        .join(
            DocumentMember,
            and_(DocumentMember.document_id == Document.id, DocumentMember.user_id == user.id),
        )
        .join(User, User.id == Document.owner_id)
    )


async def create(
    session: AsyncSession, user: User, title: str, doc_id: uuid.UUID | None = None
) -> DocumentView:
    document = Document(id=doc_id or uuid7(), owner_id=user.id, title=title)
    session.add(document)
    await session.flush()
    session.add(DocumentMember(document_id=document.id, user_id=user.id, role=DocumentRole.OWNER))
    await session.commit()
    return DocumentView(document, DocumentRole.OWNER, user.name)


async def create_with_id(
    session: AsyncSession, user: User, doc_id: uuid.UUID, title: str
) -> tuple[DocumentView, bool]:
    """Idempotent create for offline clients. Returns (view, created).

    Replaying the same PUT returns the existing document; an id owned by someone else is a
    conflict, never a way to reach their document.
    """
    existing = await session.get(Document, doc_id)
    if existing is None:
        try:
            return await create(session, user, title, doc_id), True
        except IntegrityError:
            # A concurrent replay inserted it between our read and our write.
            await session.rollback()
            await session.refresh(user)  # rollback expired it; async sessions cannot lazy-load
            existing = await session.get(Document, doc_id)
            if existing is None:
                raise
    if existing.owner_id != user.id:
        raise ApiError(409, "id_conflict", "A document with this id already exists")
    return await get_for(session, user, doc_id, min_role=DocumentRole.OWNER), False


async def list_for(
    session: AsyncSession, user: User, *, scope: Scope, trashed: bool, limit: int
) -> list[DocumentView]:
    query = _visible_to(user)
    if trashed:
        # Only owners see their Trash; collaborators lose sight of a trashed document.
        query = query.where(Document.deleted_at.is_not(None), Document.owner_id == user.id)
    else:
        query = query.where(Document.deleted_at.is_(None))
        if scope is Scope.OWNED:
            query = query.where(Document.owner_id == user.id)
        elif scope is Scope.SHARED:
            query = query.where(Document.owner_id != user.id)
    query = query.order_by(Document.updated_at.desc(), Document.id.desc()).limit(limit)
    rows = await session.execute(query)
    return [DocumentView(doc, role, owner_name) for doc, role, owner_name in rows]


async def get_for(
    session: AsyncSession,
    user: User,
    doc_id: uuid.UUID,
    *,
    min_role: DocumentRole = DocumentRole.VIEWER,
    include_trashed: bool = False,
) -> DocumentView:
    row = (await session.execute(_visible_to(user).where(Document.id == doc_id))).first()
    # Not a member and trashed both look like "not found": existence is not leaked.
    if row is None or (row[0].deleted_at is not None and not include_trashed):
        raise ApiError(404, "document_not_found", "Document not found")
    document, role, owner_name = row
    if ROLE_RANK[role] < ROLE_RANK[min_role]:
        raise ApiError(403, "insufficient_role", f"Requires {min_role.value} access")
    return DocumentView(document, role, owner_name)


async def rename(session: AsyncSession, view: DocumentView, title: str) -> DocumentView:
    view.document.title = title
    await session.commit()
    return view


async def trash(session: AsyncSession, view: DocumentView, now: datetime) -> None:
    view.document.deleted_at = now
    await session.commit()


async def restore(session: AsyncSession, view: DocumentView) -> DocumentView:
    view.document.deleted_at = None
    await session.commit()
    return view


# ----- search --------------------------------------------------------------------------------

ENGLISH: ColumnElement[Any] = literal_column("'english'::regconfig")
SIMPLE: ColumnElement[Any] = literal_column("'simple'::regconfig")
# Characters with a meaning in tsquery syntax, and control characters (Postgres rejects NUL
# outright); splitting on them leaves only plain words.
_QUERY_SYNTAX = re.compile(r"[\s&|!():*<>'\"\\\x00-\x1f\x7f]+")
MAX_SEARCH_TERMS = 8
# \x02 and \x03 never occur in search_text (see app.collab.text), so they mark matches safely.
MATCH_START, MATCH_STOP = "\x02", "\x03"
_HEADLINE = (
    f"StartSel={MATCH_START}, StopSel={MATCH_STOP}, "
    'MaxWords=30, MinWords=12, MaxFragments=2, FragmentDelimiter=" … "'
)
_MARKER = re.compile(f"[{MATCH_START}{MATCH_STOP}]")


def search_terms(text: str) -> list[str]:
    return [term for term in _QUERY_SYNTAX.split(text) if term][:MAX_SEARCH_TERMS]


def match_query(terms: list[str]) -> ColumnElement[str]:
    """Every term must match, as a prefix, either stemmed or as typed (see SEARCH_VECTOR).

    Each term is quoted and passed as a bound parameter: what someone types can never become
    tsquery operators, let alone SQL.
    """

    def term_query(term: str) -> ColumnElement[str]:
        prefix = f"'{term}':*"
        return func.to_tsquery(ENGLISH, prefix).op("||")(func.to_tsquery(SIMPLE, prefix))

    return reduce(lambda left, right: left.op("&&")(right), map(term_query, terms))


def snippet_parts(headline: str) -> list[SnippetPart]:
    # Markers alternate start, stop, start …, so every odd piece is a match.
    pieces = _MARKER.split(headline)
    return [
        SnippetPart(text=piece, match=index % 2 == 1) for index, piece in enumerate(pieces) if piece
    ]


async def search(session: AsyncSession, user: User, text: str, limit: int) -> list[SearchHit]:
    """Documents the user can open whose title or body matches, best matches first."""
    terms = search_terms(text)
    if not terms:
        return []
    query = match_query(terms)
    rows = (
        await session.execute(
            _visible_to(user)
            .where(Document.deleted_at.is_(None), Document.search_tsv.op("@@")(query))
            # A match in the title weighs more than one in the body (setweight A vs B).
            .order_by(func.ts_rank(Document.search_tsv, query).desc(), Document.updated_at.desc())
            .limit(limit)
        )
    ).all()
    if not rows:
        return []
    # Highlighting re-parses the text, so it runs only for the hits, not for every match.
    headlines = {
        doc_id: headline
        for doc_id, headline in await session.execute(
            select(
                Document.id,
                func.ts_headline(SIMPLE, Document.search_text, query, _HEADLINE),
            ).where(Document.id.in_([doc.id for doc, _, _ in rows]))
        )
    }
    return [
        SearchHit(
            document=DocumentView(doc, role, owner_name).out(),
            snippet=snippet_parts(headlines.get(doc.id) or ""),
        )
        for doc, role, owner_name in rows
    ]
