"""branches

Revision ID: b48a71d073f4
Revises: f6fd411a9dd7
Create Date: 2026-10-02 18:48:34.968787
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b48a71d073f4"
down_revision: str | None = "f6fd411a9dd7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SNAPSHOT_KINDS = ("compaction", "auto", "named", "pre_restore")


def upgrade() -> None:
    op.create_table(
        "document_branches",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("document_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=60), nullable=False),
        sa.Column("description", sa.Text(), server_default="", nullable=False),
        sa.Column(
            "status",
            sa.Enum("open", "merged", "closed", name="branch_status"),
            server_default="open",
            nullable=False,
        ),
        sa.Column("base_state", sa.LargeBinary(), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("review_requested_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("merged_by", sa.Uuid(), nullable=True),
        sa.Column("merged_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["users.id"],
            name=op.f("fk_document_branches_created_by_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["documents.id"],
            name=op.f("fk_document_branches_document_id_documents"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["merged_by"],
            ["users.id"],
            name=op.f("fk_document_branches_merged_by_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_document_branches")),
    )
    op.create_index(
        op.f("ix_document_branches_document_id"), "document_branches", ["document_id"], unique=False
    )
    op.create_index(
        "uq_document_branches_open_name",
        "document_branches",
        ["document_id", "name"],
        unique=True,
        postgresql_where=sa.text("status = 'open'"),
    )

    for table in ("document_updates", "document_snapshots"):
        op.add_column(table, sa.Column("branch_id", sa.Uuid(), nullable=True))
        op.create_foreign_key(
            op.f(f"fk_{table}_branch_id_document_branches"),
            table,
            "document_branches",
            ["branch_id"],
            ["id"],
            ondelete="CASCADE",
        )
    op.create_index(
        "ix_document_updates_branch_id_id",
        "document_updates",
        ["branch_id", "id"],
        unique=False,
        postgresql_where=sa.text("branch_id IS NOT NULL"),
    )

    # One compaction base per stream: main's is keyed by document, each branch's by branch.
    op.drop_index(
        "uq_document_snapshots_compaction",
        table_name="document_snapshots",
        postgresql_where=sa.text("kind = 'compaction'"),
    )
    op.create_index(
        "uq_document_snapshots_compaction",
        "document_snapshots",
        ["document_id"],
        unique=True,
        postgresql_where=sa.text("kind = 'compaction' AND branch_id IS NULL"),
    )
    op.create_index(
        "uq_document_snapshots_branch_compaction",
        "document_snapshots",
        ["branch_id"],
        unique=True,
        postgresql_where=sa.text("kind = 'compaction' AND branch_id IS NOT NULL"),
    )

    # Usable from the next transaction on; nothing in this migration uses it.
    op.execute("ALTER TYPE snapshot_kind ADD VALUE IF NOT EXISTS 'pre_merge'")


def downgrade() -> None:
    # Postgres cannot drop an enum value: rebuild the type without it.
    op.execute("DELETE FROM document_snapshots WHERE kind = 'pre_merge'")
    op.execute("ALTER TYPE snapshot_kind RENAME TO snapshot_kind_old")
    sa.Enum(*SNAPSHOT_KINDS, name="snapshot_kind").create(op.get_bind())
    op.drop_index(
        "uq_document_snapshots_compaction",
        table_name="document_snapshots",
        postgresql_where=sa.text("kind = 'compaction' AND branch_id IS NULL"),
    )
    op.drop_index(
        "uq_document_snapshots_branch_compaction",
        table_name="document_snapshots",
        postgresql_where=sa.text("kind = 'compaction' AND branch_id IS NOT NULL"),
    )
    op.execute(
        "ALTER TABLE document_snapshots ALTER COLUMN kind TYPE snapshot_kind"
        " USING kind::text::snapshot_kind"
    )
    op.execute("DROP TYPE snapshot_kind_old")

    op.drop_index(
        "ix_document_updates_branch_id_id",
        table_name="document_updates",
        postgresql_where=sa.text("branch_id IS NOT NULL"),
    )
    op.execute("DELETE FROM document_snapshots WHERE branch_id IS NOT NULL")
    op.execute("DELETE FROM document_updates WHERE branch_id IS NOT NULL")
    for table in ("document_snapshots", "document_updates"):
        op.drop_constraint(
            op.f(f"fk_{table}_branch_id_document_branches"), table, type_="foreignkey"
        )
        op.drop_column(table, "branch_id")
    op.create_index(
        "uq_document_snapshots_compaction",
        "document_snapshots",
        ["document_id"],
        unique=True,
        postgresql_where=sa.text("kind = 'compaction'"),
    )

    op.drop_index(
        "uq_document_branches_open_name",
        table_name="document_branches",
        postgresql_where=sa.text("status = 'open'"),
    )
    op.drop_index(op.f("ix_document_branches_document_id"), table_name="document_branches")
    op.drop_table("document_branches")
    sa.Enum(name="branch_status").drop(op.get_bind(), checkfirst=False)
