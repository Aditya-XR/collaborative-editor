"""snapshots and search

Revision ID: bb86555f0bb3
Revises: 3d4fa2fa3c91
Create Date: 2026-10-02 00:37:26.975743
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "bb86555f0bb3"
down_revision: str | None = "3d4fa2fa3c91"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SEARCH_VECTOR = (
    "setweight(to_tsvector('english'::regconfig, title)"
    " || to_tsvector('simple'::regconfig, title), 'A')"
    " || setweight(to_tsvector('english'::regconfig, search_text)"
    " || to_tsvector('simple'::regconfig, search_text), 'B')"
)


def upgrade() -> None:
    op.create_table(
        "document_snapshots",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("document_id", sa.Uuid(), nullable=False),
        sa.Column(
            "kind",
            sa.Enum("compaction", "auto", "named", "pre_restore", name="snapshot_kind"),
            nullable=False,
        ),
        sa.Column("state", sa.LargeBinary(), nullable=False),
        sa.Column("label", sa.String(length=100), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("source_id", sa.Uuid(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["users.id"],
            name=op.f("fk_document_snapshots_created_by_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["documents.id"],
            name=op.f("fk_document_snapshots_document_id_documents"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["source_id"],
            ["document_snapshots.id"],
            name=op.f("fk_document_snapshots_source_id_document_snapshots"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_document_snapshots")),
    )
    op.create_index(
        "ix_document_snapshots_document_id_created_at",
        "document_snapshots",
        ["document_id", "created_at"],
        unique=False,
    )
    op.create_index(
        "uq_document_snapshots_compaction",
        "document_snapshots",
        ["document_id"],
        unique=True,
        postgresql_where=sa.text("kind = 'compaction'"),
    )
    # Existing documents start with empty search text; their body becomes searchable the next
    # time the server folds their edit log (the end of their next editing session).
    op.add_column(
        "documents", sa.Column("search_text", sa.Text(), server_default="", nullable=False)
    )
    op.add_column(
        "documents",
        sa.Column(
            "search_tsv",
            postgresql.TSVECTOR(),
            sa.Computed(SEARCH_VECTOR, persisted=True),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_documents_search_tsv",
        "documents",
        ["search_tsv"],
        unique=False,
        postgresql_using="gin",
    )


def downgrade() -> None:
    op.drop_index("ix_documents_search_tsv", table_name="documents", postgresql_using="gin")
    op.drop_column("documents", "search_tsv")
    op.drop_column("documents", "search_text")
    op.drop_index(
        "uq_document_snapshots_compaction",
        table_name="document_snapshots",
        postgresql_where=sa.text("kind = 'compaction'"),
    )
    op.drop_index("ix_document_snapshots_document_id_created_at", table_name="document_snapshots")
    op.drop_table("document_snapshots")
    sa.Enum(name="snapshot_kind").drop(op.get_bind(), checkfirst=False)
