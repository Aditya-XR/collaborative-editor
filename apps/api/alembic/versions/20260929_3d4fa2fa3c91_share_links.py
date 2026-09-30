"""share links

Revision ID: 3d4fa2fa3c91
Revises: b42139ffebbf
Create Date: 2026-09-29 04:40:39.547229
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "3d4fa2fa3c91"
down_revision: str | None = "b42139ffebbf"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "share_links",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("document_id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column(
            "role",
            # The type already exists (document_members.role); reuse it, don't create it again.
            postgresql.ENUM(name="document_role", create_type=False),
            nullable=False,
        ),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["users.id"],
            name=op.f("fk_share_links_created_by_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["documents.id"],
            name=op.f("fk_share_links_document_id_documents"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_share_links")),
        sa.UniqueConstraint("token_hash", name=op.f("uq_share_links_token_hash")),
    )
    op.create_index(
        op.f("ix_share_links_document_id"), "share_links", ["document_id"], unique=False
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_share_links_document_id"), table_name="share_links")
    op.drop_table("share_links")
