"""backfill search text

Documents edited before full-text search existed have empty search text until their next
editing session. This fills it in once, from each document's stored state.

Revision ID: f6fd411a9dd7
Revises: bb86555f0bb3
Create Date: 2026-10-02 15:02:11.402316
"""

import re
from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op
from pycrdt import Doc, XmlElement, XmlFragment, XmlText, merge_updates

revision: str = "f6fd411a9dd7"
down_revision: str | None = "bb86555f0bb3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# A frozen copy of app.collab.text as it was when this migration was written: a migration must
# keep doing what it did, whatever later happens to the application code.
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def _plain_text(doc: Doc[Any]) -> str:
    lines: list[str] = []

    def walk(node: XmlFragment | XmlElement) -> None:
        for child in node.children:
            if isinstance(child, XmlText):
                lines.append("".join(run for run, _ in child.diff() if isinstance(run, str)))
            else:
                walk(child)

    walk(doc.get("default", type=XmlFragment))
    return _CONTROL.sub(" ", "\n".join(line for line in lines if line))[:100_000]


def upgrade() -> None:
    bind = op.get_bind()
    document_ids = bind.execute(
        sa.text("SELECT id FROM documents WHERE search_text = ''")
    ).scalars()
    for document_id in list(document_ids):
        base = bind.execute(
            sa.text(
                "SELECT state FROM document_snapshots"
                " WHERE document_id = :id AND kind = 'compaction'"
            ),
            {"id": document_id},
        ).scalar()
        rows = bind.execute(
            sa.text("SELECT update FROM document_updates WHERE document_id = :id ORDER BY id"),
            {"id": document_id},
        ).scalars()
        updates = ([base] if base is not None else []) + list(rows)
        if not updates:
            continue
        doc: Doc[Any] = Doc()
        doc.apply_update(merge_updates(*updates))
        text = _plain_text(doc)
        if text:
            bind.execute(
                sa.text("UPDATE documents SET search_text = :text WHERE id = :id"),
                {"text": text, "id": document_id},
            )


def downgrade() -> None:
    pass  # data only: the text is derived, and keeping it is harmless
