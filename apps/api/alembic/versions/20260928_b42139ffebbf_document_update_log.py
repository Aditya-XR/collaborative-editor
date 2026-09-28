"""document update log

Revision ID: b42139ffebbf
Revises: 5b8feee2a23f
Create Date: 2026-09-28 21:33:52.265939
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b42139ffebbf"
down_revision: str | None = "5b8feee2a23f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "document_updates",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("document_id", sa.Uuid(), nullable=False),
        sa.Column("update", sa.LargeBinary(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["documents.id"],
            name=op.f("fk_document_updates_document_id_documents"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_document_updates_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_document_updates")),
    )
    op.create_index(
        "ix_document_updates_document_id_id",
        "document_updates",
        ["document_id", "id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_document_updates_document_id_id", table_name="document_updates")
    op.drop_table("document_updates")
