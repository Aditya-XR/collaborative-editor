"""phase 9: per-member stars, client ids for comments written offline

Revision ID: 2a17c64d404c
Revises: 13fcb228b019
Create Date: 2026-10-22 15:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "2a17c64d404c"
down_revision: str | None = "13fcb228b019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Nullable columns with no default: adding them rewrites no rows.
    op.add_column(
        "document_members", sa.Column("starred_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("comment_threads", sa.Column("client_id", sa.Uuid(), nullable=True))
    op.create_unique_constraint(
        op.f("uq_comment_threads_client_id"), "comment_threads", ["client_id"]
    )
    op.add_column("comments", sa.Column("client_id", sa.Uuid(), nullable=True))
    op.create_unique_constraint(op.f("uq_comments_client_id"), "comments", ["client_id"])


def downgrade() -> None:
    op.drop_constraint(op.f("uq_comments_client_id"), "comments", type_="unique")
    op.drop_column("comments", "client_id")
    op.drop_constraint(op.f("uq_comment_threads_client_id"), "comment_threads", type_="unique")
    op.drop_column("comment_threads", "client_id")
    op.drop_column("document_members", "starred_at")
