"""Imports every ORM model so Base.metadata is complete (Alembic autogenerate, test cleanup)."""

from app.auth.models import AccountToken, OAuthAccount, RefreshToken, User
from app.branches.models import DocumentBranch
from app.collab.models import DocumentSnapshot, DocumentUpdate
from app.comments.models import Comment, CommentThread
from app.documents.models import Document, DocumentMember
from app.sharing.models import ShareLink

__all__ = [
    "AccountToken",
    "Comment",
    "CommentThread",
    "Document",
    "DocumentBranch",
    "DocumentMember",
    "DocumentSnapshot",
    "DocumentUpdate",
    "OAuthAccount",
    "RefreshToken",
    "ShareLink",
    "User",
]
